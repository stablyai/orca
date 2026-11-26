import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCAD_LOCK_FILE_NAME } from './orcad-instance-lock'
import { readOrcadInstanceLockRecord } from './orcad-instance-lock-record'
import type { OrcadLockRecord } from './orcad-instance-lock-record'
import { shortDaemonSocketDir } from '../../daemon/endpoint/publication/daemon-socket-endpoint-path'
import {
  probeOrcadEndpoint,
  reclaimStaleOrcadInstanceLock,
  type OrcadStaleLockReclaimHooks
} from './orcad-stale-lock-reclaim'

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Short roots keep macOS Unix sockets below the 104-byte limit.
function makeRoot(): string {
  const root = mkdtempSync('/tmp/orcad-reclaim-')
  roots.push(root)
  return root
}

const HOLDER_PID = 15698

function holderRecord(overrides: Partial<OrcadLockRecord> = {}): OrcadLockRecord {
  return {
    pid: HOLDER_PID,
    startedAtMs: 1,
    linuxStartTicks: '77',
    bootId: 'boot-1',
    identity: '1000',
    version: '1.0.0',
    acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    nonce: 'stale-holder',
    role: 'orcad',
    host: 'box',
    ...overrides
  }
}

function rebootedBox(overrides: OrcadStaleLockReclaimHooks = {}): OrcadStaleLockReclaimHooks {
  return {
    hostname: () => 'box',
    bootId: () => 'boot-2',
    machineIdentity: () => null,
    dataRootIsOnLocalDisk: () => false,
    lockHooks: {
      identity: () => '1000',
      machineIdentity: () => null,
      dataRootIsOnLocalDisk: () => false,
      processIsAlive: () => false,
      incarnation: () => ({ linuxStartTicks: '9', bootId: 'boot-2' })
    },
    ...overrides
  }
}

function writeLock(root: string, record: OrcadLockRecord): string {
  const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
  writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600 })
  const writtenAt = new Date(record.acquiredAt)
  utimesSync(lockPath, writtenAt, writtenAt)
  return lockPath
}

// Reclamation is Linux-only; these fixtures need POSIX modes and sockets.
describe.skipIf(process.platform === 'win32')('reclaimStaleOrcadInstanceLock (#32177)', () => {
  it('clears a lock from an earlier boot on this host once every check passes and --yes', async () => {
    const root = makeRoot()
    const lockPath = writeLock(root, holderRecord())
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, hintRuntime: null },
      rebootedBox()
    )
    expect(result).toMatchObject({ status: 'reclaimed', exitCode: 0 })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('reclaims under --expect-nonce only the record the dry run showed', async () => {
    const root = makeRoot()
    const lockPath = writeLock(root, holderRecord())
    const changed = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, expectNonce: 'approved-earlier', hintRuntime: null },
      rebootedBox()
    )
    expect(changed).toMatchObject({
      status: 'refused',
      message: 'The lock changed after you checked it. Check it again.'
    })
    expect(existsSync(lockPath)).toBe(true)
    const pinned = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, expectNonce: 'stale-holder', hintRuntime: null },
      rebootedBox()
    )
    expect(pinned).toMatchObject({ status: 'reclaimed', evidence: { nonce: 'stale-holder' } })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('never reports an empty data root as a recovery', async () => {
    const result = await reclaimStaleOrcadInstanceLock(
      makeRoot(),
      { yes: true, hintRuntime: null },
      rebootedBox()
    )
    expect(result).toMatchObject({
      status: 'none',
      exitCode: 4,
      message: expect.stringContaining('--data-root')
    })
  })

  it('without --yes, names what it found and warns about other machines, then refuses', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: false, hintRuntime: null },
      rebootedBox()
    )
    expect(result).toMatchObject({
      status: 'eligible',
      exitCode: 2,
      evidence: { pid: HOLDER_PID, host: 'box', bootId: 'boot-1', currentBootId: 'boot-2' }
    })
    for (const evidence of [`pid ${HOLDER_PID}`, 'host box', 'boot boot-1', '10 minutes ago']) {
      expect(result.message).toContain(evidence)
    }
    expect(result.message).toContain('nothing answers on this machine')
    expect(result.message).toContain('cannot rule out another machine with the same host name')
    expect(result.message).toContain('no other machine sharing this home runs Orca')
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  it('refuses while the holder still answers at its endpoint', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(join(root, `o-${HOLDER_PID}-rt.sock`), resolve)
    )
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, hintRuntime: null },
      rebootedBox()
    )
    expect(result).toMatchObject({
      status: 'refused',
      exitCode: 1,
      message: expect.stringContaining('Something on this machine answers')
    })
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  it('refuses while the holder answers at a socket relocated for a long data root', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    const relocatedDir = shortDaemonSocketDir(root, process.getuid!())
    mkdirSync(relocatedDir, { recursive: true, mode: 0o700 })
    roots.push(relocatedDir)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(join(relocatedDir, `o-${HOLDER_PID}-rt.sock`), resolve)
    )
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, hintRuntime: null },
      rebootedBox()
    )
    expect(result).toMatchObject({
      status: 'refused',
      message: expect.stringContaining('Something on this machine answers')
    })
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  // Root reads through mode 000, so the case only exists for an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    'refuses, rather than reporting nothing to do, when the lock cannot be reached',
    async () => {
      const root = makeRoot()
      writeLock(root, holderRecord())
      chmodSync(root, 0o000)
      try {
        const result = await reclaimStaleOrcadInstanceLock(
          root,
          { yes: true, hintRuntime: null },
          rebootedBox()
        )
        expect(result).toMatchObject({
          exitCode: 1,
          message: expect.stringContaining('cannot be read')
        })
      } finally {
        chmodSync(root, 0o700)
      }
    }
  )

  it('probes an IPv6 WebSocket endpoint by its bare address', async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await expect(probeOrcadEndpoint(`ws://[::1]:${port}`)).resolves.toBe('answers')
  })

  it('reclaims a holder whose PID was reused after the reboot, but not one it cannot identify', async () => {
    const reused = makeRoot()
    const reusedLock = writeLock(reused, holderRecord())
    const alive = (incarnation: { linuxStartTicks: string; bootId: string } | null) =>
      rebootedBox({
        lockHooks: {
          ...rebootedBox().lockHooks,
          processIsAlive: () => true,
          incarnation: () => incarnation
        }
      })
    const reclaimed = await reclaimStaleOrcadInstanceLock(
      reused,
      { yes: true, hintRuntime: null },
      alive({ linuxStartTicks: '9', bootId: 'boot-2' })
    )
    expect(reclaimed.status).toBe('reclaimed')
    expect(existsSync(reusedLock)).toBe(false)

    const unreadable = makeRoot()
    writeLock(unreadable, holderRecord())
    const refused = await reclaimStaleOrcadInstanceLock(
      unreadable,
      { yes: true, hintRuntime: null },
      alive(null)
    )
    expect(refused.status).toBe('refused')
    expect(readOrcadInstanceLockRecord(join(unreadable, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  it('never clears a record other than the one it checked', async () => {
    const root = makeRoot()
    const lockPath = writeLock(root, holderRecord())
    const swap = async (): Promise<'silent'> => {
      writeLock(root, holderRecord({ nonce: 'newer-holder' }))
      return 'silent'
    }
    writeFileSync(join(root, `o-${HOLDER_PID}-rt.sock`), '')
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, hintRuntime: null },
      rebootedBox({ probeEndpoint: swap })
    )
    expect(result.status).toBe('refused')
    expect(readOrcadInstanceLockRecord(lockPath)?.nonce).toBe('newer-holder')
    expect(result.message).not.toContain(process.execPath)
    if (process.platform === 'linux') {
      expect(result.message).toContain(`orca serve --reclaim-stale-lock --data-root ${root}`)
    }
  })

  it('refuses a lock refreshed three minutes ago, which NFS caching can show for a live clone (#32918)', async () => {
    const root = makeRoot()
    const acquiredAt = '2026-01-01T00:00:00.000Z'
    writeLock(root, holderRecord({ acquiredAt }))
    const now = () => Date.parse(acquiredAt) + 3 * 60_000
    const result = await reclaimStaleOrcadInstanceLock(
      root,
      { yes: true, hintRuntime: null },
      rebootedBox({ now, bootStartedAtMs: () => Date.parse(acquiredAt) - 60_000 })
    )
    expect(result).toMatchObject({
      status: 'refused',
      message: expect.stringContaining('minutes old')
    })
  })
})
