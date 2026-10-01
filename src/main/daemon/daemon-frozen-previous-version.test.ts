import './mock-descendant-sweep'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { finishPtyShutdown, verifyPtyStopped } from '../ipc/pty/provider/liveness'
import { setLocalPtyProvider } from '../ipc/pty/provider/registry'
import { shutdownProviderAndDetectExit } from '../ipc/pty/provider/shutdown-detect'
import type { PtyRuntimeControllerDeps } from '../ipc/pty/runtime/controller-deps'
import { stopAndWaitPtyFromRuntimeController } from '../ipc/pty/runtime/kill'
import { collectGenerations } from '../ipc/pty-management-generations'
import { listAnsweredProcesses } from '../providers/pty-process-source-listing'
import { USER_FACING_DAEMON_LISTING_TIMEOUT_MS } from './daemon-generation-listing'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree, teardownRpcDeadline } from '../runtime/worktree-teardown'
import { persistedPaneSessionIdsForWorktree } from '../runtime/worktree-persisted-pane-sessions'
import { WORKTREE_TEARDOWN_FORCE_HINT } from '../../shared/worktree/removal'
import type { DaemonFileLog } from './daemon-file-log'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'

// A previous-version daemon behind a byte proxy in its own process: SIGSTOP of that recorded pid
// freezes the version the way a stalled daemon does, while the real servers keep running here.
const PROXY_SOURCE = `
const net = require('node:net')
const [listenPath, targetPath] = process.argv.slice(1)
net.createServer((client) => {
  const upstream = net.connect(targetPath)
  client.pipe(upstream)
  upstream.pipe(client)
  const end = () => { client.destroy(); upstream.destroy() }
  for (const s of [client, upstream]) { s.on('error', end); s.on('close', end) }
}).listen(listenPath, () => process.stdout.write('ready\\n'))
`
const LEGACY = 35
const silentLog: DaemonFileLog = { log: () => {}, close: () => {} }

function fixtureSubprocess(pid: number): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stopAndWait reads only these controller ports; spawn ports are unused.
const stopDeps = {
  runtime: undefined,
  getLocalPtyProviderStartupPromise: () => undefined,
  shutdownProviderAndDetectExit,
  rememberSyntheticKillExit: () => {},
  sendPtyExitToRenderer: () => {},
  finishPtyShutdown,
  retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>()
} as unknown as PtyRuntimeControllerDeps

/** The runtime's worktree sweep loop, over terminals it knows: each one goes through stopAndWait. */
function runtimeKnowing(ptyIds: string[]): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only stopTerminalsForWorktree on the runtime.
  return {
    stopTerminalsForWorktree: async (
      _worktree: string,
      options: {
        deadline: number
        stopPty: (id: string, stop: () => Promise<boolean>) => Promise<{ stopped: boolean }>
      }
    ) => {
      let stopped = 0
      for (const ptyId of ptyIds) {
        const result = await options.stopPty(ptyId, () =>
          stopAndWaitPtyFromRuntimeController(stopDeps, ptyId, {
            deadlineMs: teardownRpcDeadline(options.deadline)
          })
        )
        stopped += result.stopped ? 1 : 0
      }
      return { stopped }
    }
  } as unknown as OrcaRuntimeService
}

describe.skipIf(process.platform === 'win32')(
  'a previous daemon version frozen after startup',
  () => {
    const servers: DaemonServer[] = []
    const adapters: DaemonPtyAdapter[] = []
    let proxy: ChildProcess | undefined
    let runtimeDir = ''
    let router: DaemonPtyRouter
    let current: DaemonPtyAdapter
    let legacy: DaemonPtyAdapter[]

    function adapterFor(protocolVersion: number): DaemonPtyAdapter {
      const adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
        tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
        protocolVersion
      })
      adapters.push(adapter)
      return adapter
    }

    async function startServer(socketPath: string, protocolVersion: number): Promise<void> {
      let spawned = 0
      const server = new DaemonServer({
        socketPath,
        tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
        protocolVersion,
        log: silentLog,
        spawnSubprocess: () => fixtureSubprocess(protocolVersion * 1_000 + spawned++)
      })
      servers.push(server)
      await server.start()
    }

    function signalProxy(signal: NodeJS.Signals): void {
      if (proxy?.pid !== undefined && proxy.exitCode === null) {
        process.kill(proxy.pid, signal)
      }
    }

    beforeAll(async () => {
      runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-frozen-'))
      mkdirSync(join(runtimeDir, 'real'))
      const realLegacySocket = join(runtimeDir, 'real', 'legacy.sock')
      await startServer(realLegacySocket, LEGACY)
      await startServer(getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION), PROTOCOL_VERSION)
      proxy = spawn(
        process.execPath,
        ['-e', PROXY_SOURCE, getDaemonSocketPath(runtimeDir, LEGACY), realLegacySocket],
        { stdio: ['ignore', 'pipe', 'inherit'] }
      )
      await new Promise<void>((resolve) => proxy!.stdout!.once('data', () => resolve()))

      // A previous app run left terminals of workspaces wt-old and wt-unv in v35, then quit.
      const previousApp = adapterFor(LEGACY)
      await previousApp.spawn({ sessionId: 'wt-old@@aaaa0001', cols: 80, rows: 24 })
      await previousApp.spawn({ sessionId: 'wt-unv@@dddd0004', cols: 80, rows: 24 })
      previousApp.dispose()

      // App start as daemon-provider-init does it; fresh terminals land in the current version.
      legacy = await createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))
      adapters.push(...legacy)
      current = adapterFor(PROTOCOL_VERSION)
      router = new DaemonPtyRouter({ current, legacy })
      await router.discoverLegacySessions()
      setLocalPtyProvider(router)
      for (const sessionId of ['wt-new@@bbbb0002', 'wt-new@@bbbb0003', 'wt-stop@@cccc0005']) {
        await router.spawn({ sessionId, cols: 80, rows: 24 })
      }
      signalProxy('SIGSTOP')
    }, 60_000)

    afterAll(async () => {
      // Why the recorded pid only: never signal a process this test did not start.
      signalProxy('SIGCONT')
      signalProxy('SIGKILL')
      router?.disposeRouterOnly()
      for (const adapter of adapters) {
        adapter.dispose()
      }
      await Promise.all(servers.map((server) => server.shutdown()))
      rmSync(runtimeDir, { recursive: true, force: true })
    }, 60_000)

    it('lists the current version within the deadline and marks the frozen one unverifiable', async () => {
      const started = Date.now()
      const generations = await collectGenerations({ adapters: [current, ...legacy], current })

      expect(Date.now() - started).toBeLessThan(4_500)
      expect(generations.map((g) => [g.protocolVersion, g.contact])).toEqual([
        [PROTOCOL_VERSION, 'live'],
        [LEGACY, 'unverifiable']
      ])
      const live = generations[0]
      expect(live.contact === 'live' && live.sessions.map((s) => s.sessionId).sort()).toEqual([
        'wt-new@@bbbb0002',
        'wt-new@@bbbb0003',
        'wt-stop@@cccc0005'
      ])
    }, 20_000)

    it('answers the Resource Manager listing within the deadline, naming the frozen version', async () => {
      const unverifiable: { protocolVersion: number | null }[] = []
      const started = Date.now()
      const answered = await listAnsweredProcesses(
        router,
        (source) => unverifiable.push(source),
        Date.now() + USER_FACING_DAEMON_LISTING_TIMEOUT_MS
      )

      expect(Date.now() - started).toBeLessThan(4_500)
      expect(answered.map((process) => process.id)).toContain('wt-stop@@cccc0005')
      expect(unverifiable.map((source) => source.protocolVersion)).toEqual([LEGACY])
    }, 20_000)

    it('confirms a stop of a current-version terminal without waiting on the frozen version', async () => {
      const started = Date.now()
      const deadlineMs = started + 5_000
      await router.shutdown('wt-stop@@cccc0005', { immediate: true, deadlineMs })

      await expect(verifyPtyStopped(router, 'wt-stop@@cccc0005', { deadlineMs })).resolves.toBe(
        true
      )
      expect(Date.now() - started).toBeLessThan(3_000)
    }, 20_000)

    it('never confirms a stop of a terminal the frozen version owns', async () => {
      const deadlineMs = Date.now() + 2_500
      const stop = router.shutdown('wt-old@@aaaa0001', { immediate: true, deadlineMs })
      void stop.catch(() => {})
      await Promise.race([stop.catch(() => {}), new Promise((r) => setTimeout(r, 3_000))])

      await expect(
        verifyPtyStopped(router, 'wt-old@@aaaa0001', { deadlineMs: Date.now() + 2_500 })
      ).rejects.toThrow('did not answer')
    }, 20_000)

    it('deletes a workspace with only current-version terminals and names the unchecked version', async () => {
      const result = await killAllProcessesForWorktree('wt-new', {
        runtime: runtimeKnowing(['wt-new@@bbbb0002', 'wt-new@@bbbb0003']),
        localProvider: router,
        requirePhysicalStop: true,
        timeoutMs: 6_000
      })

      expect(result.runtimeStopped).toBe(2)
      expect(result.uncheckedTerminalServices).toEqual([{ protocolVersion: LEGACY }])
    }, 30_000)

    it('refuses with the Force Delete hint when the frozen version holds a terminal of the workspace', async () => {
      // No tab and no runtime id: only the id the frozen version was routed before the freeze.
      await expect(
        killAllProcessesForWorktree('wt-old', {
          localProvider: router,
          requirePhysicalStop: true,
          timeoutMs: 6_000
        })
      ).rejects.toThrow(WORKTREE_TEARDOWN_FORCE_HINT)
    }, 30_000)

    it('refuses for a restored pane whose only link to the frozen version is its saved id', async () => {
      // Discovery routed wt-unv's id to v35 before the freeze; drop that so only the pane's id remains.
      const restartedLegacy = await createLegacyDaemonAdapters(
        runtimeDir,
        join(runtimeDir, 'history')
      )
      adapters.push(...restartedLegacy)
      const restartedCurrent = adapterFor(PROTOCOL_VERSION)
      const restarted = new DaemonPtyRouter({ current: restartedCurrent, legacy: restartedLegacy })
      await restarted.discoverLegacySessions()
      setLocalPtyProvider(restarted)
      try {
        const silent = (
          await restarted.listProcessesBySource({ deadlineMs: Date.now() + 2_000 })
        ).find((listing) => listing.protocolVersion === LEGACY)
        expect(silent?.contact === 'unverifiable' && silent.lastKnownIds).toEqual([])

        // The tab's reattach failed, so only its saved binding in the workspace session names the id.
        const savedSession = {
          tabsByWorktree: {
            'wt-unv': [{ id: 'tab-unv', worktreeId: 'wt-unv', ptyId: 'wt-unv@@dddd0004' }]
          },
          terminalLayoutsByTabId: {
            'tab-unv': { ptyIdsByLeafId: { 'leaf-1': 'wt-unv@@dddd0004' } }
          }
        }
        await expect(
          killAllProcessesForWorktree('wt-unv', {
            localProvider: restarted,
            requirePhysicalStop: true,
            timeoutMs: 6_000,
            persistedPaneSessionIds: persistedPaneSessionIdsForWorktree(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader uses only tab id, worktreeId, ptyId and layout ptyIdsByLeafId.
              savedSession as unknown as Parameters<typeof persistedPaneSessionIdsForWorktree>[0],
              'wt-unv'
            )
          })
        ).rejects.toThrow(WORKTREE_TEARDOWN_FORCE_HINT)

        // Residual by design: with no tab and no route, nothing names the id; delete goes ahead and says so.
        const tabless = await killAllProcessesForWorktree('wt-unv', {
          localProvider: restarted,
          requirePhysicalStop: true,
          timeoutMs: 6_000
        })
        expect(tabless.uncheckedTerminalServices).toEqual([{ protocolVersion: LEGACY }])
      } finally {
        restarted.disposeRouterOnly()
        setLocalPtyProvider(router)
      }
    }, 60_000)
  }
)
