import type * as NodeFs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishDaemonPidFile, serializeDaemonPidFile } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

/**
 * Fault injection for the publish path. A crash, power loss, or forced kill can stop a
 * publisher after any number of bytes have reached the disk; `tornWriteBytes` models that by
 * persisting only a prefix and then throwing. `linkError` models filesystems where hard-link
 * publication is refused. `events` records the syscall order the durability contract depends on.
 */
const fsFaults: {
  tornWriteBytes: number | null
  linkError: NodeJS.ErrnoException | null
  events: string[]
} = { tornWriteBytes: null, linkError: null, events: [] }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    fsFaults.events.push(`write:${String(file)}`)
    if (fsFaults.tornWriteBytes !== null && typeof data === 'string') {
      actual.writeFileSync(file, data.slice(0, fsFaults.tornWriteBytes), options)
      throw Object.assign(new Error('injected crash mid-write'), { code: 'EIO' })
    }
    actual.writeFileSync(file, data, options)
  }
  const linkSync: typeof actual.linkSync = (existingPath, newPath) => {
    if (fsFaults.linkError) {
      throw fsFaults.linkError
    }
    fsFaults.events.push(`link:${String(newPath)}`)
    actual.linkSync(existingPath, newPath)
  }
  const fsyncSync: typeof actual.fsyncSync = (fd) => {
    fsFaults.events.push('fsync')
    actual.fsyncSync(fd)
  }
  return { ...actual, default: actual, writeFileSync, linkSync, fsyncSync }
})

const RECORD = {
  pid: 4242,
  startedAtMs: 1_700_000_000_000,
  launchNonce: 'launch-nonce-a'
}

let dir: string
let pidPath: string

function listPublishScratch(): string[] {
  return readdirSync(dir).filter((name) => name !== 'daemon-v1.pid')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-pid-atomic-'))
  pidPath = join(dir, 'daemon-v1.pid')
  fsFaults.tornWriteBytes = null
  fsFaults.linkError = null
  fsFaults.events = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('publishDaemonPidFile atomicity', () => {
  it('never leaves a torn record at the canonical path when the publisher dies mid-write', () => {
    fsFaults.tornWriteBytes = 11

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow('injected crash mid-write')

    // The reader contract: the canonical path holds either a complete record or nothing.
    // A torn prefix is unparseable, and for a retired protocol version nothing ever heals
    // it — the corrupt file becomes a permanent veto on pruning that version.
    let observed: string | null = null
    try {
      observed = readFileSync(pidPath, 'utf8')
    } catch {
      // ENOENT is the acceptable "nothing published" outcome.
    }
    if (observed !== null) {
      expect(parseDaemonPidFile(observed)).not.toBeNull()
    }
  })

  it('cleans up its claim scratch when the publisher fails mid-write in-process', () => {
    fsFaults.tornWriteBytes = 11

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow('injected crash mid-write')

    expect(listPublishScratch()).toEqual([])
  })

  it('publishes a record readers can parse, with no scratch left behind', () => {
    publishDaemonPidFile(pidPath, RECORD)

    expect(parseDaemonPidFile(readFileSync(pidPath, 'utf8'))).toMatchObject(RECORD)
    expect(listPublishScratch()).toEqual([])
  })

  it('flushes the record to disk before it becomes visible at the canonical path', () => {
    publishDaemonPidFile(pidPath, RECORD)

    const fsyncAt = fsFaults.events.indexOf('fsync')
    const publishAt = fsFaults.events.findIndex(
      (event) => event === `link:${pidPath}` || event === `write:${pidPath}`
    )
    // Why: link/rename publication is atomic for readers but not for power loss. If the
    // canonical name can become durable before the bytes, a reboot can resurrect exactly
    // the torn record this publish discipline exists to prevent.
    expect(fsyncAt).toBeGreaterThanOrEqual(0)
    expect(publishAt).toBeGreaterThan(fsyncAt)
  })

  it('still refuses to replace an existing record, leaving it untouched', () => {
    const existing = serializeDaemonPidFile({ pid: 1, startedAtMs: 5, launchNonce: 'other' })
    publishDaemonPidFile(pidPath, { pid: 1, startedAtMs: 5, launchNonce: 'other' })

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow(/EEXIST/)
    expect(readFileSync(pidPath, 'utf8')).toBe(existing)
    expect(listPublishScratch()).toEqual([])
  })

  it('degrades to the exclusive direct write when the filesystem cannot hard-link', () => {
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    publishDaemonPidFile(pidPath, RECORD)

    expect(parseDaemonPidFile(readFileSync(pidPath, 'utf8'))).toMatchObject(RECORD)
    expect(listPublishScratch()).toEqual([])
  })

  it('keeps exclusive-create semantics on the degraded path too', () => {
    publishDaemonPidFile(pidPath, { pid: 1, startedAtMs: 5, launchNonce: 'other' })
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow(/EEXIST/)
    expect(listPublishScratch()).toEqual([])
  })
})
