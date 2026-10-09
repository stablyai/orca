import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { SessionNotFoundError } from './daemon-errors'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { legacyDaemonProcessLiveness } from './legacy-daemon-exit-evidence'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'

vi.mock('../memory/pty-registry', () => ({ listRegisteredPtys: () => [] }))

const LEGACY_PROTOCOL = 40
// Why: far above every platform's pid ceiling, so no process can answer for it.
const EXITED_PID = 999_999_999
const WORKTREE_ID = 'repo-1::/workspace/wt-1'

/** Leaves the socket file an exited daemon leaves behind: present, with nothing listening. */
async function leaveStaleSocketFile(path: string): Promise<void> {
  const livePath = `${path}.live`
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(livePath, resolve))
  linkSync(livePath, path)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

// Unix socket files only; Windows endpoints are named pipes with no leftover file.
describe.skipIf(process.platform === 'win32')(
  'a preserved older daemon that exited while the app ran',
  () => {
    let harness: DaemonAdapterHarness
    let legacy: DaemonPtyAdapter | null = null

    beforeEach(async () => {
      harness = await startDaemonAdapterHarness(() => createMockSubprocess())
      await leaveStaleSocketFile(getDaemonSocketPath(harness.dir, LEGACY_PROTOCOL))
    })

    afterEach(async () => {
      legacy?.dispose()
      legacy = null
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    })

    function adoptLegacyDaemon(pidAtAdoption: number | null): DaemonPtyAdapter {
      const pidPath = getDaemonPidPath(harness.dir, LEGACY_PROTOCOL)
      if (pidAtAdoption !== null) {
        writeFileSync(pidPath, String(pidAtAdoption))
      }
      legacy = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(harness.dir, LEGACY_PROTOCOL),
        tokenPath: getDaemonTokenPath(harness.dir, LEGACY_PROTOCOL),
        pidPath,
        protocolVersion: LEGACY_PROTOCOL
      })
      // An orderly exit unlinks the daemon's own pid record; only the socket file stays.
      rmSync(pidPath, { force: true })
      return legacy
    }

    it('lets a worktree delete stop the current daemon terminals', async () => {
      const router = new DaemonPtyRouter({
        current: harness.adapter,
        legacy: [adoptLegacyDaemon(EXITED_PID)]
      })
      await harness.adapter.spawn({ cols: 80, rows: 24, sessionId: `${WORKTREE_ID}@@aaaa1111` })

      const result = await killAllProcessesForWorktree(WORKTREE_ID, {
        localProvider: router,
        includeLocalRegistry: false,
        requirePhysicalStop: true
      })

      expect(result.providerStopped).toBe(1)
      await expect(router.listProcesses()).resolves.toEqual([])
    })

    it('drops the exited daemon from the router so no reader asks it again', async () => {
      const exited = adoptLegacyDaemon(EXITED_PID)
      const legacyList = vi.spyOn(exited, 'listProcesses')
      const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [exited] })

      await router.listProcesses()
      await router.listProcesses()

      expect(exited.hasDaemonExited()).toBe(true)
      expect(router.getLegacyAdapters()).toEqual([])
      expect(router.getAllAdapters()).toEqual([harness.adapter])
      expect(legacyList).toHaveBeenCalledTimes(1)
    })

    it('lets a pane routed to the exited daemon cold-restore instead of failing to reattach', async () => {
      const socketPath = getDaemonSocketPath(harness.dir, LEGACY_PROTOCOL)
      rmSync(socketPath, { force: true })
      const legacyServer = new DaemonServer({
        socketPath,
        tokenPath: getDaemonTokenPath(harness.dir, LEGACY_PROTOCOL),
        protocolVersion: LEGACY_PROTOCOL,
        log: { log: () => {}, close() {} },
        spawnSubprocess: () => createMockSubprocess()
      })
      await legacyServer.start()
      const router = new DaemonPtyRouter({
        current: harness.adapter,
        legacy: [adoptLegacyDaemon(EXITED_PID)]
      })
      const sessionId = `${WORKTREE_ID}@@bbbb2222`
      // Why through the legacy adapter: the router records the route the pane would reattach by.
      await legacy!.spawn({ cols: 80, rows: 24, sessionId })
      await router.discoverLegacySessions()
      await legacyServer.shutdown()
      await waitFor(() => legacy!.getDaemonIdentity() === null)

      await expect(
        router.spawn({ cols: 80, rows: 24, attachOnly: true, sessionId })
      ).rejects.toBeInstanceOf(SessionNotFoundError)
      expect(legacy!.hasDaemonExited()).toBe(true)
    })

    it('reads an unrouted session as absent in the same lookup that finds the daemon exited', async () => {
      const router = new DaemonPtyRouter({
        current: harness.adapter,
        legacy: [adoptLegacyDaemon(EXITED_PID)]
      })

      await expect(
        router.spawn({
          cols: 80,
          rows: 24,
          attachOnly: true,
          sessionId: `${WORKTREE_ID}@@cccc3333`
        })
      ).rejects.toBeInstanceOf(SessionNotFoundError)
    })

    it('drops the exited daemon from the degraded provider too', async () => {
      const exited = adoptLegacyDaemon(EXITED_PID)
      const fallback = new DaemonPtyAdapter({
        socketPath: harness.socketPath,
        tokenPath: harness.tokenPath
      })
      const provider = new DegradedDaemonPtyProvider({
        current: harness.adapter,
        legacy: [exited],
        fallback
      })
      try {
        await expect(provider.listProcesses()).resolves.toEqual([])
        expect(provider.getLegacyAdapters()).toEqual([])
      } finally {
        fallback.dispose()
      }
    })

    it('lists no sessions for the exited daemon in the session manager', async () => {
      await expect(adoptLegacyDaemon(EXITED_PID).listSessions()).resolves.toEqual([])
    })

    it('still refuses while the old daemon process may be alive', async () => {
      const router = new DaemonPtyRouter({
        current: harness.adapter,
        legacy: [adoptLegacyDaemon(process.pid)]
      })

      await expect(router.listProcesses()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })

    it('leaves a daemon that can be respawned to its own recovery', async () => {
      const pidPath = getDaemonPidPath(harness.dir, LEGACY_PROTOCOL)
      writeFileSync(pidPath, String(EXITED_PID))
      legacy = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(harness.dir, LEGACY_PROTOCOL),
        tokenPath: getDaemonTokenPath(harness.dir, LEGACY_PROTOCOL),
        pidPath,
        protocolVersion: LEGACY_PROTOCOL,
        respawn: async () => {}
      })
      rmSync(pidPath, { force: true })

      await expect(legacy.listProcesses()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })

    it('still refuses when no pid record ever named the old daemon', async () => {
      const router = new DaemonPtyRouter({
        current: harness.adapter,
        legacy: [adoptLegacyDaemon(null)]
      })

      await expect(router.listProcesses()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })
  }
)

describe('legacyDaemonProcessLiveness', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-daemon-exit-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const record = (pid: number) => ({
    pid,
    startedAtMs: null,
    entryPath: null,
    appVersion: null,
    launchNonce: null,
    linuxStartTicks: null,
    bootId: null,
    spawnerExecPath: null,
    cgroupUnit: null
  })

  it('is exited only when every known pid is gone', () => {
    const pidPath = join(dir, 'daemon-v40.pid')
    expect(legacyDaemonProcessLiveness(pidPath, record(EXITED_PID))).toEqual({ status: 'exited' })
    writeFileSync(pidPath, String(process.pid))
    expect(legacyDaemonProcessLiveness(pidPath, record(EXITED_PID))).toEqual({ status: 'live' })
  })

  it('is unverifiable for an unreadable record or no record at all', () => {
    const pidPath = join(dir, 'daemon-v40.pid')
    expect(legacyDaemonProcessLiveness(pidPath, null).status).toBe('unverifiable')
    writeFileSync(pidPath, 'not a pid')
    expect(legacyDaemonProcessLiveness(pidPath, record(EXITED_PID)).status).toBe('unverifiable')
  })
})
