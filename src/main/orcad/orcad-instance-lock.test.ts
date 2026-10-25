import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { z } from 'zod'
import {
  acquireOrcadInstanceLock,
  ORCAD_LOCK_FILE_NAME,
  readOrcadInstanceLockRecord,
  type OrcadInstanceLockHooks,
  type OrcadLockRecord
} from './orcad-instance-lock'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { orcadLockRecoveryPrefix } from './orcad-instance-lock-reclaim'

// Runs once, right after the next rename out of the canonical lock path: a contender's turn.
const afterLockRename = vi.hoisted((): { next: (() => void) | null; failNext: boolean } => ({
  next: null,
  failNext: false
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      if (afterLockRename.failNext && String(from).endsWith('orcad.lock')) {
        afterLockRename.failNext = false
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      }
      actual.renameSync(from, to)
      const contender = afterLockRename.next
      if (contender && String(from).endsWith('orcad.lock')) {
        afterLockRename.next = null
        contender()
      }
    }
  }
})

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
    incarnation: () => null,
    holderIdentity: () => 'matches',
    processIsAlive: () => false,
    machineIdentity: () => 'machine-a',
    dataRootIsOnLocalDisk: () => true,
    ...overrides
  }
}

function persistedRecord(overrides: Partial<OrcadLockRecord> = {}): OrcadLockRecord {
  return {
    pid: 424242,
    startedAtMs: 1,
    identity: 'uid-1000',
    version: '1.0.0-test',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    nonce: 'stale',
    ...overrides
  }
}

afterEach(() => {
  afterLockRename.next = null
  afterLockRename.failNext = false
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
    writeFileSync(join(root, ORCAD_LOCK_FILE_NAME), JSON.stringify(persistedRecord()))
    const lock = acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => false }))
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
  })

  it('treats a live pid whose start time does not match as a recycled pid, not a holder', () => {
    const root = makeRoot()
    writeFileSync(join(root, ORCAD_LOCK_FILE_NAME), JSON.stringify(persistedRecord()))
    const lock = acquireOrcadInstanceLock(
      root,
      hooks({ processIsAlive: () => true, holderIdentity: () => 'differs' })
    )
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
  })

  it('keeps a live holder whose ticks match though its btime-derived start time drifted', () => {
    const root = makeRoot()
    const incarnation = { linuxStartTicks: '1234', bootId: 'boot-a' }
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify(persistedRecord({ startedAtMs: 1_000, ...incarnation }))
    )
    const drifted = {
      processIsAlive: () => true,
      holderIdentity: undefined,
      startedAtMs: () => 158_000,
      incarnation: () => incarnation
    }
    expect(() => acquireOrcadInstanceLock(root, hooks(drifted))).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_held' })
    )
    const reused = { ...drifted, incarnation: () => ({ ...incarnation, linuxStartTicks: '9' }) }
    expect(acquireOrcadInstanceLock(root, hooks(reused)).record.nonce).not.toBe('stale')
  })

  // The platform hook also drives data-root privacy, whose POSIX mode check a Windows temp dir fails.
  describe.runIf(process.platform !== 'win32')(
    'an older Linux record whose wall-clock start time disagrees',
    () => {
      const olderRecord = persistedRecord({
        identity: '1000',
        acquiredAt: '2026-01-01T00:00:00.000Z'
      })
      const liveMismatch = (ownerUid: number | null): OrcadInstanceLockHooks =>
        hooks({
          identity: () => '1000',
          processIsAlive: () => true,
          holderIdentity: undefined,
          startedAtMs: () => 9e9,
          ownerUid: () => ownerUid,
          processName: () => 'postgres',
          platform: 'linux'
        })

      // Same boot or not, btime drift alone can produce this mismatch, so it proves nothing.
      it.each([
        ['the same uid', 1000],
        ['root, which a non-dumpable process also shows as', 0],
        ['an unreadable owner', null]
      ])('stays held when the live PID is owned by %s', (_owner, ownerUid) => {
        const root = makeRoot()
        const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
        writeFileSync(lockPath, JSON.stringify(olderRecord))
        let error: unknown
        try {
          acquireOrcadInstanceLock(root, liveMismatch(ownerUid))
        } catch (caught) {
          error = caught
        }
        expect(error).toEqual(expect.objectContaining({ code: 'orcad_instance_lock_held' }))
        const message = error instanceof Error ? error.message : ''
        expect(message).toContain('pid 424242')
        expect(message).toContain('"postgres"')
        expect(message).toContain('reused the PID')
        expect(message).toContain(`delete ${lockPath}`)
        expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('stale')
      })

      it('is reclaimed when another non-root uid now owns the PID', () => {
        const root = makeRoot()
        writeFileSync(join(root, ORCAD_LOCK_FILE_NAME), JSON.stringify(olderRecord))
        expect(acquireOrcadInstanceLock(root, liveMismatch(1001)).record.nonce).not.toBe('stale')
      })

      it('says "an unknown program" when the live process name cannot be read', () => {
        const root = makeRoot()
        writeFileSync(join(root, ORCAD_LOCK_FILE_NAME), JSON.stringify(olderRecord))
        expect(() =>
          acquireOrcadInstanceLock(root, { ...liveMismatch(1000), processName: () => null })
        ).toThrow(
          expect.objectContaining({ message: expect.stringContaining('an unknown program') })
        )
      })

      it('keeps the plain refusal for a record that carries a boot id', () => {
        const root = makeRoot()
        writeFileSync(
          join(root, ORCAD_LOCK_FILE_NAME),
          JSON.stringify({ ...olderRecord, bootId: 'boot-a' })
        )
        expect(() => acquireOrcadInstanceLock(root, liveMismatch(1000))).toThrow(
          expect.objectContaining({
            code: 'orcad_instance_lock_held',
            message: expect.stringContaining('already owns the data root')
          })
        )
      })
    }
  )

  it('records the incarnation in a lock an older reader still parses', () => {
    const root = makeRoot()
    const incarnation = { linuxStartTicks: '1234', bootId: 'boot-a' }
    const lock = acquireOrcadInstanceLock(root, hooks({ incarnation: () => incarnation }))
    const written: unknown = JSON.parse(readFileSync(lock.path, 'utf8'))
    expect(written).toMatchObject({ startedAtMs: 1_000, ...incarnation })
    // The shape desktops before this change parse with: unknown keys are dropped, not refused.
    const olderReader = z.object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().finite().nonnegative().nullable(),
      identity: z.string().min(1),
      version: z.string().min(1),
      acquiredAt: z.iso.datetime({ offset: true }),
      nonce: z.string().min(1),
      role: z.enum(['orcad', 'desktop']).optional()
    })
    expect(olderReader.parse(written)).toEqual({
      pid: process.pid,
      startedAtMs: 1_000,
      identity: 'uid-1000',
      version: '1.0.0-test',
      acquiredAt: lock.record.acquiredAt,
      nonce: lock.record.nonce,
      role: 'orcad'
    })
    lock.release()
  })

  it('reads an older lock without an incarnation, and salvages a malformed one', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify(persistedRecord({ linuxStartTicks: undefined }))
    )
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))).not.toHaveProperty(
      'linuxStartTicks'
    )
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({ ...persistedRecord(), linuxStartTicks: 12, bootId: '' })
    )
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))).toMatchObject({
      nonce: 'stale',
      linuxStartTicks: undefined,
      bootId: undefined
    })
  })

  it('does not displace a successor published between stale inspection and reclaim', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    const successor = persistedRecord({ pid: 777, startedAtMs: 2, nonce: 'successor' })
    writeFileSync(lockPath, JSON.stringify(persistedRecord()))
    let raced = false
    const lockHooks = hooks({
      processIsAlive: () => {
        if (!raced) {
          raced = true
          // Simulate a contender replacing the stale record and publishing its own lock
          // after this process inspected liveness but before it renames the entry.
          const displacedPath = `${lockPath}.displaced`
          renameSync(lockPath, displacedPath)
          writeFileSync(lockPath, JSON.stringify(successor), { flag: 'wx', mode: 0o600 })
        }
        return false
      }
    })

    expect(() => acquireOrcadInstanceLock(root, lockHooks)).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_held' })
    )
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe('successor')
  })

  it('never reclaims a lock held by a different identity, even a dead one', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify(persistedRecord({ identity: 'uid-2000', nonce: 'other' }))
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
      JSON.stringify(persistedRecord({ pid: 777, startedAtMs: 2, nonce: 'successor' }))
    )
    lock.release()
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).nonce).toBe('successor')
  })

  const garbledLocks = [
    ['nothing (a torn write)', ''],
    ['invalid JSON', '{'],
    ['an incomplete record', JSON.stringify({ pid: 424242, identity: 'uid-1000' })],
    ['an invalid pid', JSON.stringify(persistedRecord({ pid: -1 }))],
    ['an invalid start time', JSON.stringify({ ...persistedRecord(), startedAtMs: 'yesterday' })]
  ]

  it.each(garbledLocks)('leaves a lock still being written alone: %s', (_label, contents) => {
    const root = makeRoot()
    writeFileSync(join(root, ORCAD_LOCK_FILE_NAME), contents)

    expect(() => acquireOrcadInstanceLock(root, hooks())).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_held' })
    )
    expect(readFileSync(join(root, ORCAD_LOCK_FILE_NAME), 'utf8')).toBe(contents)
  })

  it.each(garbledLocks)('reclaims an abandoned lock containing %s', (_label, contents) => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    writeFileSync(lockPath, contents)
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo)

    const lock = acquireOrcadInstanceLock(root, hooks())
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(lock.record.nonce)
    expect(readdirSync(root).sort()).toEqual([ORCAD_LOCK_FILE_NAME])
  })

  it('fails closed when the existing lock is not a regular file', () => {
    const root = makeRoot()
    mkdirSync(join(root, ORCAD_LOCK_FILE_NAME))

    expect(() => acquireOrcadInstanceLock(root, hooks())).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_unreadable' })
    )
  })

  it('fails closed without reading an oversized lock into memory', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    writeFileSync(lockPath, 'x'.repeat(64 * 1024 + 1))

    expect(() => acquireOrcadInstanceLock(root, hooks())).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_unreadable' })
    )
    expect(statSync(lockPath).size).toBe(64 * 1024 + 1)
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

  // Not as root: root owns /tmp, so "a root this process does not own" has no stand-in there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'refuses a data root owned by another uid',
    () => {
      const root = makeRoot()
      // /tmp itself is root-owned and sticky on every supported platform, so it stands in for
      // "a data root this process does not own" without needing privileges to create one.
      expect(() => acquireOrcadInstanceLock('/tmp', hooks())).toThrow(
        expect.objectContaining({ code: 'orcad_data_root_wrong_owner' })
      )
      // And the private root this test made is still acceptable, so the refusal is about
      // ownership rather than a blanket rejection.
      expect(acquireOrcadInstanceLock(root, hooks()).record.identity).toBe('uid-1000')
    }
  )

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

  it('restricts a Windows data root by ACL, and refuses when the ACL cannot be applied', () => {
    const root = makeRoot()
    const restricted: string[] = []
    const windows = (applied: boolean) =>
      hooks({
        platform: 'win32',
        restrictWindowsDataRoot: (path) => {
          restricted.push(path)
          return applied
        }
      })
    expect(() => acquireOrcadInstanceLock(root, windows(false))).toThrow(
      expect.objectContaining({ code: 'orcad_data_root_shared' })
    )
    // Refused before any record was published.
    expect(() => readFileSync(join(root, ORCAD_LOCK_FILE_NAME))).toThrow()
    expect(acquireOrcadInstanceLock(root, windows(true)).record.pid).toBe(process.pid)
    expect(restricted).toEqual([root, root])
  })

  it.runIf(process.platform === 'win32')(
    'records a real creation time and leaves a really restricted data root on Windows',
    () => {
      const root = makeRoot()
      const lock = acquireOrcadInstanceLock(root, { identity: () => 'uid-1000' })
      expect(lock.record.startedAtMs).toEqual(expect.any(Number))
      expect(
        Math.abs(lock.record.startedAtMs! - (Date.now() - process.uptime() * 1000))
      ).toBeLessThan(5_000)
      lock.release()
    }
  )

  it('makes the desktop app and orcad refuse each other on one profile', () => {
    const root = makeRoot()
    const desktop = acquireOrcadInstanceLock(root, hooks({ role: 'desktop' }))
    expect(JSON.parse(readFileSync(desktop.path, 'utf8')).role).toBe('desktop')
    expect(() => acquireOrcadInstanceLock(root, hooks({ processIsAlive: () => true }))).toThrow(
      expect.objectContaining({
        code: 'orcad_instance_lock_held',
        message: expect.stringContaining('The Orca desktop app')
      })
    )
    desktop.release()
    const orcad = acquireOrcadInstanceLock(root, hooks())
    expect(() =>
      acquireOrcadInstanceLock(root, hooks({ role: 'desktop', processIsAlive: () => true }))
    ).toThrow(
      expect.objectContaining({
        code: 'orcad_instance_lock_held',
        message: expect.stringContaining('Another orcad')
      })
    )
    orcad.release()
  })

  it('lets a desktop reclaim a crashed desktop record whose PID was reused', () => {
    const root = makeRoot()
    writeFileSync(
      join(root, ORCAD_LOCK_FILE_NAME),
      JSON.stringify(persistedRecord({ role: 'desktop', startedAtMs: null }))
    )
    // A null start time cannot disprove the reused PID; Electron's own lock already does.
    const lock = acquireOrcadInstanceLock(
      root,
      hooks({ role: 'desktop', processIsAlive: () => true })
    )
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).nonce).toBe(lock.record.nonce)
    lock.release()
  })

  it('never judges a holder on another machine by a PID this machine issued', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    // Machine B's orcad holds a data root on a shared home; its PID does not exist here.
    const remote = persistedRecord({ nonce: 'machine-b', machineIdentity: 'machine-b' })
    writeFileSync(lockPath, JSON.stringify(remote))
    for (const role of ['orcad', 'desktop'] as const) {
      expect(() => acquireOrcadInstanceLock(root, hooks({ role }))).toThrow(
        expect.objectContaining({
          code: 'orcad_instance_lock_holder_unverifiable',
          message: expect.stringContaining('from another machine')
        })
      )
    }
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('machine-b')
    expect(readdirSync(root)).toEqual([ORCAD_LOCK_FILE_NAME])

    // The same machine's crashed holder is still reclaimed.
    writeFileSync(lockPath, JSON.stringify({ ...remote, machineIdentity: 'machine-a' }))
    const lock = acquireOrcadInstanceLock(root, hooks())
    expect(readOrcadInstanceLockRecord(lockPath)).toMatchObject({
      nonce: lock.record.nonce,
      machineIdentity: 'machine-a'
    })
  })

  it('never lets a confirmed reclaim take a lock another machine id holds', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    writeFileSync(lockPath, JSON.stringify(persistedRecord({ machineIdentity: 'machine-b' })))
    expect(() => acquireOrcadInstanceLock(root, hooks({ reclaimConfirmed: () => true }))).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_holder_unverifiable' })
    )
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('stale')
  })

  it('reclaims a record naming no machine only when it is provably from this one', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    // An older writer's record, on a data root other machines may share.
    writeFileSync(lockPath, JSON.stringify(persistedRecord({ bootId: 'boot-1' })))
    const shared = { dataRootIsOnLocalDisk: () => false }
    expect(() => acquireOrcadInstanceLock(root, hooks(shared))).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_holder_unverifiable' })
    )
    expect(() =>
      acquireOrcadInstanceLock(root, hooks({ ...shared, machineIdentity: () => null }))
    ).toThrow(expect.objectContaining({ code: 'orcad_instance_lock_holder_unverifiable' }))
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('stale')

    // The same kernel boot is this machine.
    const sameBoot = hooks({
      ...shared,
      incarnation: () => ({ linuxStartTicks: '1', bootId: 'boot-1' })
    })
    acquireOrcadInstanceLock(root, sameBoot).release()
    // So is a data root only this machine mounts.
    writeFileSync(lockPath, JSON.stringify(persistedRecord()))
    expect(acquireOrcadInstanceLock(root, hooks()).record.machineIdentity).toBe('machine-a')
  })

  it('admits one owner when reclaimers of the same stale lock interleave', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    writeFileSync(lockPath, JSON.stringify(persistedRecord()))
    const owners: { record: OrcadLockRecord }[] = []
    const failures: unknown[] = []
    const attempt = (lockHooks: OrcadInstanceLockHooks): void => {
      try {
        owners.push(acquireOrcadInstanceLock(root, lockHooks))
      } catch (error) {
        failures.push(error)
      }
    }
    let raced = false
    // A has read the stale record when B reclaims it and publishes its own; then, the moment
    // anything renames B's live lock away, C tries the momentarily vacant path.
    attempt(
      hooks({
        processIsAlive: () => {
          if (!raced) {
            raced = true
            attempt(hooks())
            afterLockRename.next = () => attempt(hooks())
          }
          return false
        }
      })
    )

    expect(owners).toHaveLength(1)
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe(owners[0]?.record.nonce)
    expect(failures).toEqual([expect.objectContaining({ code: 'orcad_instance_lock_held' })])
    expect(readdirSync(root)).toEqual([ORCAD_LOCK_FILE_NAME])
  })

  it('takes a new recovery generation only once every earlier owner provably exited', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    const stale = JSON.stringify(persistedRecord({ machineIdentity: 'machine-a' }))
    const generation = (n: number): string => `${orcadLockRecoveryPrefix(lockPath, stale)}${n}`
    const leaveRecovery = (n: number, owner: string | null): void => {
      mkdirSync(generation(n))
      if (owner !== null) {
        writeFileSync(join(generation(n), 'owner'), owner)
      }
    }
    const reclaimer = (overrides: Partial<OrcadLockRecord>): string =>
      JSON.stringify(persistedRecord({ pid: 5150, nonce: 'reclaimer', ...overrides }))
    const refused = expect.objectContaining({ message: expect.stringContaining('is reclaiming') })
    // Only pid 5150, a reclaimer paused however long ago (stalled NFS, a suspended laptop), runs.
    const paused = hooks({ processIsAlive: (pid) => pid === 5150 })
    const reset = (): void => {
      for (const entry of readdirSync(root)) {
        rmSync(join(root, entry), { recursive: true, force: true })
      }
      writeFileSync(lockPath, stale)
    }

    for (const owner of [
      reclaimer({ machineIdentity: 'machine-a' }),
      // Dead here, but on another machine.
      reclaimer({ pid: 6160, machineIdentity: 'machine-b' }),
      'not a record'
    ]) {
      reset()
      leaveRecovery(0, owner)
      expect(() => acquireOrcadInstanceLock(root, paused)).toThrow(refused)
      expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('stale')
      expect(readFileSync(join(generation(0), 'owner'), 'utf8')).toBe(owner)
    }
    // An owner that cannot be read proves nothing either.
    reset()
    mkdirSync(join(generation(0), 'owner'), { recursive: true })
    expect(() => acquireOrcadInstanceLock(root, paused)).toThrow(refused)
    // Dead here, on a machine this cannot tell apart from this one.
    reset()
    leaveRecovery(0, reclaimer({ pid: 6160 }))
    expect(() =>
      acquireOrcadInstanceLock(root, hooks({ ...paused, dataRootIsOnLocalDisk: () => false }))
    ).toThrow(refused)

    // An owner that exited on this machine is a crash's; so is a generation a cleanup cut short.
    for (const owner of [reclaimer({ pid: 6160, machineIdentity: 'machine-a' }), null]) {
      reset()
      leaveRecovery(0, owner)
      const lock = acquireOrcadInstanceLock(root, paused)
      expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe(lock.record.nonce)
      expect(readdirSync(root)).toEqual([ORCAD_LOCK_FILE_NAME])
      lock.release()
    }
  })

  it('never reuses a generation a failed recovery let go of', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    const stale = JSON.stringify(persistedRecord({ machineIdentity: 'machine-a' }))
    const generation = (n: number): string => `${orcadLockRecoveryPrefix(lockPath, stale)}${n}`
    writeFileSync(lockPath, stale)
    // Its rename of the stale lock fails, so the stale record stays in place.
    afterLockRename.failNext = true
    expect(() => acquireOrcadInstanceLock(root, hooks())).toThrow(
      expect.objectContaining({ code: 'orcad_instance_lock_held' })
    )
    expect(readdirSync(generation(0)).sort()).toEqual(['owner', 'released'])

    // The next reclaimer, though this process is still alive, moves to a new generation.
    const lock = acquireOrcadInstanceLock(
      root,
      hooks({ processIsAlive: (pid) => pid === process.pid })
    )
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe(lock.record.nonce)
    expect(readdirSync(root)).toEqual([ORCAD_LOCK_FILE_NAME])
  })

  it('never displaces a reclaimer that broke the same dead recovery owner first', () => {
    const root = makeRoot()
    const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
    const stale = JSON.stringify(persistedRecord({ machineIdentity: 'machine-a' }))
    const generation = (n: number): string => `${orcadLockRecoveryPrefix(lockPath, stale)}${n}`
    writeFileSync(lockPath, stale)
    mkdirSync(generation(0))
    const dead = JSON.stringify(persistedRecord({ pid: 6160, machineIdentity: 'machine-a' }))
    writeFileSync(join(generation(0), 'owner'), dead)
    const live = JSON.stringify(persistedRecord({ pid: 5150, machineIdentity: 'machine-a' }))
    let raced = false
    // B judges generation 0's owner dead at the same moment and takes generation 1 first.
    const racing = hooks({
      processIsAlive: (pid) => {
        if (!raced && pid === 6160) {
          raced = true
          mkdirSync(generation(1))
          writeFileSync(join(generation(1), 'owner'), live)
        }
        return pid === 5150
      }
    })
    const refused = expect.objectContaining({ message: expect.stringContaining('is reclaiming') })
    expect(() => acquireOrcadInstanceLock(root, racing)).toThrow(refused)
    // And a third starter defers to B, the newest generation's live owner.
    expect(() =>
      acquireOrcadInstanceLock(root, hooks({ processIsAlive: (pid) => pid === 5150 }))
    ).toThrow(refused)
    expect(readFileSync(join(generation(1), 'owner'), 'utf8')).toBe(live)
    expect(readFileSync(join(generation(0), 'owner'), 'utf8')).toBe(dead)
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('stale')
    expect(readdirSync(root)).toHaveLength(3)
  })

  it.runIf(process.platform !== 'win32')(
    "leaves the desktop profile's permissions as they were",
    () => {
      const root = makeRoot()
      chmodSync(root, 0o755)
      const restricted: string[] = []
      acquireOrcadInstanceLock(root, hooks({ role: 'desktop' })).release()
      acquireOrcadInstanceLock(
        root,
        hooks({
          role: 'desktop',
          platform: 'win32',
          restrictWindowsDataRoot: (path) => restricted.push(path) > 0
        })
      ).release()
      expect(restricted).toEqual([])
      expect(statSync(root).mode & 0o777).toBe(0o755)
    }
  )
})
