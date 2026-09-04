import type * as NodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreClaimedDaemonArtifact, serializeDaemonPidFile } from './daemon-spawner'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

/**
 * publishDaemonPidFile is not the only writer of the canonical record: a lost publish race
 * and every content-gated unlink restore it through here. A create-then-stream copy is
 * observable half-written, so this path owes readers the same contract the publish does —
 * a complete record or none.
 */

const RECORD = { pid: 4242, startedAtMs: 1_700_000_000_000, launchNonce: 'launch-nonce-a' }

let dir: string
let claimedPath: string
let canonicalPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-restore-atomic-'))
  claimedPath = join(dir, 'daemon-v1.pid.hold-1-claim')
  canonicalPath = join(dir, 'daemon-v1.pid')
  writeFileSync(claimedPath, serializeDaemonPidFile(RECORD), { mode: 0o600 })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Models a publisher killed part-way through streaming bytes into the canonical entry. */
const tornCopy: typeof NodeFs.copyFileSync = (source, target) => {
  writeFileSync(String(target), readFileSync(String(source), 'utf8').slice(0, 11), { flag: 'wx' })
  throw Object.assign(new Error('injected crash mid-copy'), { code: 'EIO' })
}

const linkUnsupported = (): never => {
  throw Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })
}

describe('restoreClaimedDaemonArtifact publication', () => {
  it('never leaves a torn canonical record when the publisher dies part-way', () => {
    restoreClaimedDaemonArtifact(claimedPath, canonicalPath, {
      copyExclusive: (source, target) => tornCopy(source, target)
    })

    let observed: string | null = null
    try {
      observed = readFileSync(canonicalPath, 'utf8')
    } catch {
      // ENOENT is the acceptable "nothing restored" outcome.
    }
    if (observed !== null) {
      expect(parseDaemonPidFile(observed)).not.toBeNull()
    }
  })

  it('restores a record readers can parse, without streaming into the canonical entry', () => {
    expect(restoreClaimedDaemonArtifact(claimedPath, canonicalPath)).toBe(true)

    expect(parseDaemonPidFile(readFileSync(canonicalPath, 'utf8'))).toMatchObject(RECORD)
  })

  it('never overwrites a newer canonical replacement', () => {
    const replacement = serializeDaemonPidFile({ pid: 1, startedAtMs: 5, launchNonce: 'newer' })
    writeFileSync(canonicalPath, replacement, { mode: 0o600 })

    // True means "the claim may be dropped", which a confirmed replacement also licenses.
    expect(restoreClaimedDaemonArtifact(claimedPath, canonicalPath)).toBe(true)
    expect(readFileSync(canonicalPath, 'utf8')).toBe(replacement)
  })

  it('does not retry through the copy when the link already proved a replacement exists', () => {
    writeFileSync(canonicalPath, 'newer', { mode: 0o600 })
    const copyExclusive = vi.fn()

    expect(restoreClaimedDaemonArtifact(claimedPath, canonicalPath, { copyExclusive })).toBe(true)

    // A second exclusive attempt against a live record can only fail the same way.
    expect(copyExclusive).not.toHaveBeenCalled()
  })

  it('reports no restore when the link proved a replacement that then vanished', () => {
    writeFileSync(canonicalPath, 'newer', { mode: 0o600 })

    expect(
      restoreClaimedDaemonArtifact(claimedPath, canonicalPath, { canonicalExists: () => false })
    ).toBe(false)
  })

  it('degrades to the exclusive copy when the filesystem cannot hard-link', () => {
    expect(
      restoreClaimedDaemonArtifact(claimedPath, canonicalPath, { linkExclusive: linkUnsupported })
    ).toBe(true)

    expect(parseDaemonPidFile(readFileSync(canonicalPath, 'utf8'))).toMatchObject(RECORD)
  })

  it('keeps replacement-preserving semantics on the degraded path too', () => {
    const replacement = serializeDaemonPidFile({ pid: 1, startedAtMs: 5, launchNonce: 'newer' })
    writeFileSync(canonicalPath, replacement, { mode: 0o600 })

    expect(
      restoreClaimedDaemonArtifact(claimedPath, canonicalPath, { linkExclusive: linkUnsupported })
    ).toBe(true)
    expect(readFileSync(canonicalPath, 'utf8')).toBe(replacement)
  })
})
