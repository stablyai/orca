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
  claimWriteError: NodeJS.ErrnoException | null
  linkError: NodeJS.ErrnoException | null
  events: string[]
} = { tornWriteBytes: null, claimWriteError: null, linkError: null, events: [] }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    fsFaults.events.push(`write:${String(file)}`)
    // A full-disk or permission failure on the claim leaves no file behind at all,
    // unlike the torn write above which persists a prefix first.
    if (fsFaults.claimWriteError && String(file).includes('.publish-')) {
      throw fsFaults.claimWriteError
    }
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

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-pid-atomic-'))
  pidPath = join(dir, 'daemon-v1.pid')
  fsFaults.tornWriteBytes = null
  fsFaults.claimWriteError = null
  fsFaults.linkError = null
  fsFaults.events = []
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
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
    // The atomic path is the normal one; warning on it would train operators to ignore
    // the degrade warning below.
    expect(warnSpy).not.toHaveBeenCalled()
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
    // An ownership conflict is routine, not a degrade: warning here would make the
    // real non-atomic warning below indistinguishable from a lost publish race.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('refuses an ownership conflict outright instead of retrying it as a direct write', () => {
    // Why the conflict is modelled at link time with the canonical path FREE: the record
    // can be reclaimed between the failed link and the fallback write. Retrying the
    // conflict as an exclusive write would then succeed and silently take ownership the
    // EEXIST exists to deny. The conflict must be refused where it is detected.
    fsFaults.linkError = Object.assign(new Error('injected EEXIST'), { code: 'EEXIST' })

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow(/EEXIST/)

    expect(fsFaults.events).not.toContain(`write:${pidPath}`)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(listPublishScratch()).toEqual([])
  })

  it('surfaces the original publish failure, not the failure of its own cleanup', () => {
    // Why: when the claim write fails outright no claim exists, so the `finally` unlink
    // fails too. An unswallowed cleanup error replaces the real cause — an operator
    // debugging a full disk would be handed ENOENT instead of ENOSPC.
    fsFaults.claimWriteError = Object.assign(new Error('injected claim write failure'), {
      code: 'ENOSPC'
    })

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow('injected claim write failure')
  })

  it('degrades to the exclusive direct write when the filesystem cannot hard-link', () => {
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    publishDaemonPidFile(pidPath, RECORD)

    expect(parseDaemonPidFile(readFileSync(pidPath, 'utf8'))).toMatchObject(RECORD)
    expect(listPublishScratch()).toEqual([])
    // The degrade must be operator-visible: on a volume without hard links every publish
    // silently loses torn-write protection otherwise.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENOTSUP'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-atomic'))
  })

  it('records the degrade on the daemon file log, which is the only channel the detached daemon keeps', () => {
    // The daemon runs with stdio 'ignore' and its startup stderr pipe is destroyed once
    // it is up, so a console-only warning never reaches the operator it is written for.
    const entries: { event: string; details?: Record<string, unknown> }[] = []
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    publishDaemonPidFile(pidPath, RECORD, {
      log: (event, details) => entries.push({ event, ...(details ? { details } : {}) })
    })

    expect(entries).toEqual([{ event: 'pid-publish-degraded', details: { errno: 'ENOTSUP' } }])
  })

  it('leaves the daemon file log untouched when the atomic path succeeds', () => {
    const entries: string[] = []

    publishDaemonPidFile(pidPath, RECORD, { log: (event) => entries.push(event) })

    expect(entries).toEqual([])
  })

  it('stays silent when the degraded write itself loses the ownership race', () => {
    // Same catch arm as the degrade, but nothing was published: announcing lost
    // torn-write protection for a record that was never written is a false alarm.
    const entries: string[] = []
    publishDaemonPidFile(pidPath, { pid: 1, startedAtMs: 5, launchNonce: 'other' })
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    expect(() =>
      publishDaemonPidFile(pidPath, RECORD, { log: (event) => entries.push(event) })
    ).toThrow(/EEXIST/)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(entries).toEqual([])
  })

  it('names the errno even when the link error carries none', () => {
    fsFaults.linkError = new Error('injected link failure with no code')

    publishDaemonPidFile(pidPath, RECORD)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no errno'))
  })

  it('keeps exclusive-create semantics on the degraded path too', () => {
    publishDaemonPidFile(pidPath, { pid: 1, startedAtMs: 5, launchNonce: 'other' })
    fsFaults.linkError = Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })

    expect(() => publishDaemonPidFile(pidPath, RECORD)).toThrow(/EEXIST/)
    expect(listPublishScratch()).toEqual([])
  })
})
