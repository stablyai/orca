import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishDaemonPidFile, serializeDaemonPidFile } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

/**
 * Real-filesystem contract for the atomic pid publish. This file runs in the Windows
 * packaging job on purpose: exclusive hard-link publication is exactly the kind of
 * primitive whose semantics differ between NTFS and POSIX, and the daemon case — another
 * process holding the record open — is the one Windows historically breaks (EPERM/EACCES
 * on replace). Nothing here may mock the filesystem.
 */

const RECORD = {
  pid: 4242,
  startedAtMs: 1_700_000_000_000,
  launchNonce: 'launch-nonce-a'
}

let dir: string
let pidPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-pid-disk-'))
  pidPath = join(dir, 'daemon-v1.pid')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('daemon pid publish on-disk contract', () => {
  it('publishes a parseable record and leaves no scratch entries behind', () => {
    publishDaemonPidFile(pidPath, RECORD)

    expect(parseDaemonPidFile(readFileSync(pidPath, 'utf8'))).toMatchObject(RECORD)
    expect(readdirSync(dir)).toEqual(['daemon-v1.pid'])
    // nlink 1 proves the claim entry was consumed, not left as a second name.
    expect(statSync(pidPath).nlink).toBe(1)
    if (process.platform !== 'win32') {
      expect(statSync(pidPath).mode & 0o777).toBe(0o600)
    }
  })

  it('fails with EEXIST on an existing record and leaves its bytes untouched', () => {
    const existing = serializeDaemonPidFile({ pid: 1, startedAtMs: 5, launchNonce: 'other' })
    writeFileSync(pidPath, existing)

    let thrown: NodeJS.ErrnoException | null = null
    try {
      publishDaemonPidFile(pidPath, RECORD)
    } catch (error) {
      thrown = error as NodeJS.ErrnoException
    }

    expect(thrown?.code).toBe('EEXIST')
    expect(readFileSync(pidPath, 'utf8')).toBe(existing)
    expect(readdirSync(dir)).toEqual(['daemon-v1.pid'])
  })

  it('reports the conflict as EEXIST even while another process holds the record open', () => {
    // The daemon case on Windows: an open handle turns replace-style publication into
    // EPERM/EACCES. Exclusive link publication must instead see the existing record and
    // say so, because callers treat EEXIST as an ownership conflict, not an IO failure.
    const existing = serializeDaemonPidFile({ pid: 1, startedAtMs: 5, launchNonce: 'other' })
    writeFileSync(pidPath, existing)
    const holder = openSync(pidPath, 'r')
    try {
      let thrown: NodeJS.ErrnoException | null = null
      try {
        publishDaemonPidFile(pidPath, RECORD)
      } catch (error) {
        thrown = error as NodeJS.ErrnoException
      }

      expect(thrown?.code).toBe('EEXIST')
      expect(readFileSync(pidPath, 'utf8')).toBe(existing)
      expect(readdirSync(dir)).toEqual(['daemon-v1.pid'])
    } finally {
      closeSync(holder)
    }
  })

  it('is not blocked by scratch a dead publisher left behind', () => {
    writeFileSync(join(dir, 'daemon-v1.pid.publish-999999-dead'), '{"pid":1')

    publishDaemonPidFile(pidPath, RECORD)

    expect(parseDaemonPidFile(readFileSync(pidPath, 'utf8'))).toMatchObject(RECORD)
  })
})
