import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireOrcadInstanceLock,
  ORCAD_LOCK_FILE_NAME,
  OrcadInstanceLockError,
  type OrcadInstanceLockHooks
} from './orcad-instance-lock'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lock-'))
  roots.push(root)
  return root
}

/** Deterministic identity/liveness so the assertions do not depend on this machine's pids. */
function hooks(overrides: OrcadInstanceLockHooks = {}): OrcadInstanceLockHooks {
  return {
    identity: () => 'uid-1000',
    version: () => '1.0.0-test',
    startedAtMs: () => 1_000,
    startTimeMatches: () => true,
    processIsAlive: () => false,
    ...overrides
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('acquireOrcadInstanceLock', () => {
  it('publishes a record naming the holder and removes it on release', () => {
    const root = makeRoot()
    const lock = acquireOrcadInstanceLock(root, hooks())
    const record = JSON.parse(readFileSync(join(root, ORCAD_LOCK_FILE_NAME), 'utf8'))
    expect(record.pid).toBe(process.pid)
    expect(record.identity).toBe('uid-1000')
    expect(record.version).toBe('1.0.0-test')
    lock.release()
    expect(() => readFileSync(join(root, ORCAD_LOCK_FILE_NAME), 'utf8')).toThrow()
  })

  it('refuses a second instance while the holder is alive', () => {
    const root = makeRoot()
    acquireOrcadInstanceLock(root, hooks())
    expect(() => acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => true }))).toThrow(
      OrcadInstanceLockError
    )
    expect(() => acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => true }))).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_held' })
    )
  })

  it('reclaims the record of a holder that is gone', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({ pid: 424242, identity: 'uid-1000', startedAtMs: 1, nonce: 'stale' })
    )
    const lock = acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => false }))
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
  })

  it('treats a live pid whose start time does not match as a recycled pid, not a holder', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({ pid: 424242, identity: 'uid-1000', startedAtMs: 1, nonce: 'stale' })
    )
    const lock = acquireOrcadInstanceLock(
      root,
      hooks({ processIsAlive: () => true, startTimeMatches: () => false })
    )
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
  })

  it('never reclaims a lock held by a different identity, even a dead one', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({ pid: 424242, identity: 'uid-2000', startedAtMs: 1, nonce: 'other' })
    )
    expect(() => acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => false }))).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_foreign_identity' })
    )
  })

  it('does not delete a record that a later instance already replaced', () => {
    const root = makeRoot()
    const lock = acquireOrcadInstanceLock(root, hooks())
    // A successor reclaimed the root while this process was wedged.
    writeFileSync(
      lock.path,
      JSON.stringify({ pid: 777, identity: 'uid-1000', startedAtMs: 2, nonce: 'successor' })
    )
    lock.release()
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).nonce).toBe('successor')
  })

  it.runIf(process.platform !== 'win32')(
    'tightens a group/world-accessible data root rather than refusing when it can',
    () => {
      const root = makeRoot()
      chmodSync(root, 0o755)
      acquireOrcadInstanceLock(root, hooks())
      expect(statSync(root).mode & 0o777).toBe(0o700)
    }
  )

  it.runIf(process.platform !== 'win32')('refuses a data root owned by another uid', () => {
    const root = makeRoot()
    // /tmp itself is root-owned and sticky on every supported platform, so it stands in for
    // "a data root this process does not own" without needing privileges to create one.
    expect(() => acquireOrcadInstanceLock('/tmp', hooks())).toThrow(
      expect.objectContaining({ code: 'orcad_data_root_wrong_owner' })
    )
    // And the private root this test made is still acceptable, so the refusal is about
    // ownership rather than a blanket rejection.
    expect(acquireOrcadInstanceLock(root, hooks()).record.identity).toBe('uid-1000')
  })

  it('leaves the terminal daemon alone: the lock covers only the runtime role', () => {
    const root = makeRoot()
    // The daemon lives here and deliberately outlives the runtime. Releasing the runtime's
    // lock must not touch it, or a restart would stop being non-destructive.
    const daemonDir = join(root, 'daemon')
    mkdirSync(daemonDir, { recursive: true })
    writeFileSync(join(daemonDir, 'daemon-v36.pid'), JSON.stringify({ pid: 99, startedAtMs: 1 }))
    const lock = acquireOrcadInstanceLock(root, hooks())
    lock.release()
    expect(JSON.parse(readFileSync(join(daemonDir, 'daemon-v36.pid'), 'utf8')).pid).toBe(99)
    // And a fresh instance takes the root back while that daemon record still stands.
    const next = acquireOrcadInstanceLock(root, hooks())
    expect(next.record.pid).toBe(process.pid)
  })
})
