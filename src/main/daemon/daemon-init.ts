/* eslint-disable max-lines -- Why: owns the full daemon lifecycle (init, launch, adapter wiring,
restart, teardown); the "swap the provider atomically" invariant keeps restart + singletons co-located. */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  serializeDaemonPidFile,
  unlinkOwnedDaemonPidFile,
  type DaemonLauncher,
  type DaemonProcessHandle
} from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonClient } from './client'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type ListSessionsResult
} from './types'
import {
  getMacDaemonSystemResolverHealth,
  getDaemonLaunchIdentity,
  checkDaemonHealth,
  isDaemonStaleForCurrentBundle,
  killStaleDaemon,
  parseDaemonPidFile
} from './daemon-health'
import {
  collectPinnedDaemonVersions,
  materializeRelocatedDaemonHost,
  pruneOldDaemonHosts
} from './daemon-host-relocation'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import {
  getLocalPtyProvider,
  setLocalPtyProvider,
  unbindLocalProviderListeners,
  rebindLocalProviderListeners
} from '../ipc/pty'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import { getDaemonLogFilePath } from '../observability/logs-directory'
import {
  confirmSeededClaudeLivePtys,
  hasSeededUnconfirmedClaudePtys
} from '../claude-accounts/live-pty-gate'

// Why: daemon init runs concurrent with window load, so an in-process t timestamp (not harness stderr timing) measures cold-start.
function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}

// Why: extra hello+listSessions probes (~5s each) giving a wedged-but-connectable daemon ~60s grace to answer and keep its live sessions before a permanent wedge (#8689) is replaced; raise only alongside the fail-open cap.
export const WEDGED_DAEMON_GRACE_RETRIES = 11
const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000
const DAEMON_CHILD_TERMINATION_GRACE_MS = 5_000
const DAEMON_CHILD_FORCE_EXIT_WAIT_MS = 1_000

let spawner: DaemonSpawner | null = null
type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider

let adapter: DaemonProvider | null = null
// Why: coalesce concurrent restartDaemon() calls so two entries can't race the 7-step sequence against a half-spawned replacement.
let restartInFlight: Promise<RestartDaemonResult> | null = null

function getRuntimeDir(): string {
  const dir = join(app.getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getHistoryDir(): string {
  const dir = join(app.getPath('userData'), 'terminal-history')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getDaemonEntryPath(): string {
  const appPath = app.getAppPath()
  // Why: packaged app.getAppPath() points at app.asar, so redirect to app.asar.unpacked where daemon-entry.js is fork-executable.
  const basePath = app.isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'daemon-entry.js')
}

// Why: pass a log-file arg so field failures are diagnosable, but honor the ORCA_DIAGNOSTICS_DISABLED privacy switch.
function daemonLogArgs(): string[] {
  const disabled = (process.env.ORCA_DIAGNOSTICS_DISABLED ?? '').trim().toLowerCase()
  if (disabled === '1' || disabled === 'true') {
    return []
  }
  return ['--log-file', getDaemonLogFilePath()]
}

// Why: a socket that accepts a connection proves a daemon survived a previous app session and can be reused.
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    function finish(alive: boolean, options?: { destroy?: boolean }): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.removeListener('connect', onConnect)
      sock.removeListener('error', onError)
      if (options?.destroy) {
        sock.destroy()
      }
      resolve(alive)
    }

    function onConnect(): void {
      finish(true, { destroy: true })
    }

    function onError(): void {
      finish(false)
    }

    timer = setTimeout(() => {
      finish(false, { destroy: true })
    }, 1000)
    sock.on('connect', onConnect)
    sock.on('error', onError)
  })
}

async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await client.ensureConnected()
    const result = await client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}

function createPreservedDaemonHandle(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  mode?: 'degraded-new-pty-fallback'
): DaemonProcessHandle {
  const handle: DaemonProcessHandle = {
    shutdown: async () => {
      await cleanupDaemonForProtocol(runtimeDir, protocolVersion)
    }
  }
  if (mode) {
    handle.mode = mode
  }
  return handle
}

async function holdDaemonAdoptionLease(
  handle: DaemonProcessHandle,
  socketPath: string,
  tokenPath: string,
  connectedClient?: DaemonClient
): Promise<DaemonProcessHandle> {
  const client = connectedClient ?? new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
  } catch (error) {
    client.disconnect()
    throw error
  }
  handle.releaseAdoptionLease = () => client.disconnect()
  return handle
}

function releaseDaemonAdoptionLease(handle: DaemonProcessHandle | null): void {
  takeDaemonAdoptionLeaseRelease(handle)?.()
}

function takeDaemonAdoptionLeaseRelease(
  handle: DaemonProcessHandle | null
): (() => void) | undefined {
  const release = handle?.releaseAdoptionLease
  if (!release || !handle) {
    return undefined
  }
  delete handle.releaseAdoptionLease
  return release
}

async function cleanupFailedDaemonAdoption(
  failedSpawner: DaemonSpawner,
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[] = []
): Promise<void> {
  const handle = failedSpawner.getHandle()
  const results = await Promise.allSettled([
    Promise.resolve().then(() => releaseDaemonAdoptionLease(handle)),
    ...legacy.map((entry) => entry.disconnectOnly()),
    (async () => {
      try {
        // Why: other authenticated clients may win, so only daemon-side shutdownIfIdle can prove a failed adoption is killable.
        await current.disconnectOnly()
      } catch (error) {
        current.dispose()
        throw error
      }
    })()
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Daemon adoption cleanup failed')
  }
}

async function terminateLaunchedDaemonChild(child: ChildProcess): Promise<void> {
  try {
    if (
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined)
    ) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      let gracefulTimer: ReturnType<typeof setTimeout>
      let forcedTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(gracefulTimer)
        if (forcedTimer) {
          clearTimeout(forcedTimer)
        }
        child.off('exit', onExit)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const onExit = (): void => finish()
      child.on('exit', onExit)
      gracefulTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch (error) {
            finish(isNoSuchProcessError(error) ? undefined : error)
            return
          }
        }
        if (!settled) {
          forcedTimer = setTimeout(
            () => finish(new Error('Daemon did not exit after SIGKILL')),
            DAEMON_CHILD_FORCE_EXIT_WAIT_MS
          )
        }
      }, DAEMON_CHILD_TERMINATION_GRACE_MS)
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch (error) {
          finish(isNoSuchProcessError(error) ? undefined : error)
        }
      } else {
        finish()
      }
    })
  } finally {
    if (child.connected) {
      child.disconnect()
    }
    child.unref()
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

async function shouldPreserveDaemonWithLiveSessions(
  socketPath: string,
  tokenPath: string,
  replacementLabel: string
): Promise<boolean> {
  const liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
  if (liveSessionCount === 0) {
    return false
  }
  console.warn(
    liveSessionCount === null
      ? `[daemon] Preserving daemon ${replacementLabel} because live session state could not be verified`
      : `[daemon] Preserving daemon ${replacementLabel} because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
  )
  return true
}

function createOutOfProcessLauncher(runtimeDir: string): DaemonLauncher {
  return async (socketPath, tokenPath, suppliedPidPath, suppliedLaunchNonce) => {
    const entryPath = getDaemonEntryPath()
    const pidPath = suppliedPidPath ?? getDaemonPidPath(runtimeDir)
    const launchNonce = suppliedLaunchNonce ?? randomUUID()
    let adoptionClient: DaemonClient | null = new DaemonClient({ socketPath, tokenPath })
    try {
      // Why: acquire the full pair before control-only probes so an expired inherited deadline can't fire in the probe-to-adoption gap.
      await adoptionClient.ensureConnected()
    } catch {
      adoptionClient.disconnect()
      adoptionClient = null
    }
    const preserveDaemon = async (
      mode?: 'degraded-new-pty-fallback'
    ): Promise<DaemonProcessHandle> => {
      const connectedClient = adoptionClient ?? undefined
      adoptionClient = null
      return holdDaemonAdoptionLease(
        createPreservedDaemonHandle(runtimeDir, PROTOCOL_VERSION, mode),
        socketPath,
        tokenPath,
        connectedClient
      )
    }
    try {
      const health = await checkDaemonHealth(socketPath, tokenPath)
      if (health === 'healthy') {
        const resolverHealth = await getMacDaemonSystemResolverHealth(socketPath, tokenPath)
        if (resolverHealth === 'unhealthy') {
          const liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
          if (liveSessionCount !== 0) {
            console.warn(
              liveSessionCount === null
                ? '[daemon] Preserving daemon with unavailable macOS system resolver because live session state could not be verified'
                : `[daemon] Preserving daemon with unavailable macOS system resolver because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
            )
            return preserveDaemon()
          }
          console.warn('[daemon] Replacing daemon with unavailable macOS system resolver')
          await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
        } else {
          // Why: a protocol-healthy daemon can outlive its launching app bundle (dev worktree rebuild, or packaged update replacing the app path).
          const identity = await getDaemonLaunchIdentity(
            runtimeDir,
            socketPath,
            tokenPath,
            entryPath
          )
          const stalePackagedBundle =
            app.isPackaged &&
            (await isDaemonStaleForCurrentBundle(
              runtimeDir,
              socketPath,
              tokenPath,
              app.getVersion()
            ))
          if (identity === 'mismatch' || stalePackagedBundle) {
            // Why: replacing a healthy daemon kills its child PTYs; defer code freshness until no live sessions would be lost.
            const replacementLabel = stalePackagedBundle
              ? 'launched before the current app bundle was installed'
              : 'launched from a different app path'
            if (
              await shouldPreserveDaemonWithLiveSessions(socketPath, tokenPath, replacementLabel)
            ) {
              return preserveDaemon()
            }
            console.warn(
              stalePackagedBundle
                ? '[daemon] Replacing daemon launched before the current app bundle was installed'
                : '[daemon] Replacing daemon launched from a different app path'
            )
            await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
          } else {
            // Why: healthy daemon from a previous session answered a protocol ping — safe to reuse.
            return preserveDaemon()
          }
        }
      } else {
        // Why: a busy machine can time out the health check on a live daemon; re-verify with a session list before killing its sessions.
        let liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
        // Why: a wedged-but-connectable daemon (Windows update relaunch) may still own live sessions, so grace-retry before replacing; a permanent wedge (#8689) exhausts the grace, and 'rejected' skips it (handshake refused = never adoptable).
        let graceRetry = 0
        while (
          liveSessionCount === null &&
          health !== 'rejected' &&
          graceRetry < WEDGED_DAEMON_GRACE_RETRIES &&
          (await probeSocket(socketPath))
        ) {
          liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
          graceRetry++
        }
        if (liveSessionCount !== null && liveSessionCount > 0) {
          if (health === 'pty-spawn-unhealthy') {
            console.warn(
              `[daemon] DEGRADED MODE: preserving daemon that failed the PTY spawn health check because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).`
            )
            return preserveDaemon('degraded-new-pty-fallback')
          }
          console.warn(
            `[daemon] Preserving daemon that failed the health check because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
          )
          return preserveDaemon()
        }
      }

      // Why: a raw socket can outlive a broken daemon; kill by PID before respawn so the new daemon doesn't race the stale one.
      adoptionClient?.disconnect()
      adoptionClient = null
      await killStaleDaemon(runtimeDir, socketPath, tokenPath)

      const userDataPath = app.getPath('userData')
      // Why: on win32 packaged, stage a daemon-host copy in userData so its image escapes the NSIS updater's kill zone; lazy so it's off first-paint. Fail-open: null → in-dir host.
      const relocatedHost = materializeRelocatedDaemonHost()
      // Fork the relocated entry when available; otherwise the install-dir entry.
      const forkEntryPath = relocatedHost ? relocatedHost.entryPath : entryPath
      const child = fork(
        forkEntryPath,
        [
          '--socket',
          socketPath,
          '--token',
          tokenPath,
          '--pid-record',
          pidPath,
          '--launch-nonce',
          launchNonce,
          ...daemonLogArgs()
        ],
        {
          // Why: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
          cwd: userDataPath,
          // Why: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          // Why: run the byte-identical relocated Orca.exe so the image path sits outside the updater's kill zone.
          ...(relocatedHost ? { execPath: relocatedHost.execPath } : {}),
          // Why: run the fork as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn of the spawn-helper.
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            // Why: the detached plain-Node daemon can't call app.getPath(), but shell rcfiles must live outside swept tmp.
            ORCA_USER_DATA_PATH: userDataPath
          }
        }
      )

      // Why: keep only the startup-window stderr tail so a crash cause is visible without unbounded memory.
      const STARTUP_STDERR_MAX_BYTES = 8192
      let startupStderr = ''
      let collectingStderr = true
      const onStartupStderr = (chunk: Buffer): void => {
        if (!collectingStderr) {
          return
        }
        startupStderr += chunk.toString('utf8')
        if (startupStderr.length > STARTUP_STDERR_MAX_BYTES) {
          startupStderr = startupStderr.slice(-STARTUP_STDERR_MAX_BYTES)
        }
      }
      child.stderr?.on('data', onStartupStderr)
      // Why: release the detached daemon's stderr once up/failed — a live piped stream refs the parent loop and blocks Electron exit.
      const releaseStderr = (): void => {
        collectingStderr = false
        child.stderr?.off('data', onStartupStderr)
        child.stderr?.destroy()
      }

      // Wait for the daemon to signal readiness via IPC
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        function cleanupStartupListeners(): void {
          if (timer) {
            clearTimeout(timer)
          }
          child.off('message', onReadyMessage)
          child.off('error', onStartupError)
          child.off('exit', onStartupExit)
        }
        async function fail(error: Error): Promise<void> {
          if (settled) {
            return
          }
          settled = true
          cleanupStartupListeners()
          // Why: attach the captured stderr tail to the thrown error and log it so a startup crash isn't just "exited with code 1".
          const stderrTail = startupStderr.trim()
          if (stderrTail) {
            console.warn(`[daemon] startup failed; captured stderr tail:\n${stderrTail}`)
          }
          releaseStderr()
          const startupError = stderrTail
            ? new Error(`${error.message}\nDaemon stderr (tail):\n${stderrTail}`)
            : error
          try {
            await terminateLaunchedDaemonChild(child)
          } catch (cleanupError) {
            reject(
              new AggregateError(
                [startupError, cleanupError],
                'Daemon startup and child cleanup both failed'
              )
            )
            return
          }
          reject(startupError)
        }
        function onReadyMessage(msg: unknown): void {
          if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
            if (settled) {
              return
            }
            const selfReported = (msg as { startedAtMs?: unknown }).startedAtMs
            if (
              !Number.isSafeInteger(child.pid) ||
              (child.pid as number) <= 0 ||
              typeof selfReported !== 'number' ||
              !Number.isFinite(selfReported) ||
              selfReported <= 0
            ) {
              void fail(new Error('Daemon readiness identity is incomplete'))
              return
            }
            try {
              // Why: pid record shares the daemon's self time and nonce so cleanup can identify this exact process incarnation.
              writeFileSync(
                pidPath,
                serializeDaemonPidFile({
                  pid: child.pid as number,
                  startedAtMs: selfReported,
                  entryPath,
                  appVersion: app.getVersion(),
                  launchNonce
                }),
                { mode: 0o600, flag: 'wx' }
              )
            } catch (error) {
              void fail(error instanceof Error ? error : new Error(String(error)))
              return
            }
            settled = true
            // Why: daemon is detached after readiness; detach startup listeners so the launch promise closure isn't retained.
            cleanupStartupListeners()
            // Why: release IPC/stderr and unref so Electron can exit without waiting; the daemon keeps running detached.
            releaseStderr()
            child.disconnect()
            child.unref()
            resolve()
          }
        }

        function onStartupError(err: Error): void {
          void fail(err)
        }

        function onStartupExit(code: number | null): void {
          void fail(new Error(`Daemon exited during startup with code ${code}`))
        }

        timer = setTimeout(() => {
          void fail(new Error('Daemon startup timed out'))
        }, 10000)

        child.on('message', onReadyMessage)
        child.on('error', onStartupError)
        child.on('exit', onStartupExit)
      })

      try {
        return await holdDaemonAdoptionLease(
          {
            shutdown: () => terminateLaunchedDaemonChild(child)
          },
          socketPath,
          tokenPath
        )
      } catch (error) {
        // Why: another client may have adopted this live process; keep its pid record until exit, but remove one published after an early exit.
        let pidRecordRemoved = false
        const removeExitedPidRecord = (): void => {
          if (pidRecordRemoved) {
            return
          }
          pidRecordRemoved = true
          unlinkOwnedDaemonPidFile(pidPath, child.pid as number, launchNonce)
        }
        child.once('exit', removeExitedPidRecord)
        if (
          (child.exitCode !== null && child.exitCode !== undefined) ||
          (child.signalCode !== null && child.signalCode !== undefined)
        ) {
          child.off('exit', removeExitedPidRecord)
          removeExitedPidRecord()
        }
        throw error
      }
    } catch (error) {
      adoptionClient?.disconnect()
      throw error
    }
  }
}

export async function initDaemonPtyProvider(signal?: AbortSignal): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Why: e2e coverage for the startup PTY gate (#5232) needs a daemon init that deterministically outlasts the first-window timeout.
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir)
  })

  // Why: assign the module-level spawner/adapter only after both succeed, so a failed ensureRunning() leaves no stale spawner.
  const info = await newSpawner.ensureRunning()
  // Why: reclaim superseded daemon-host copies on EVERY launch (spawns are rare), keeping current + live-daemon-pinned versions.
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  logDaemonMilestone('daemon-current-ready')
  if (signal?.aborted) {
    // Why: fail-open may already have spawned fallback PTYs; don't install late, but retire an empty daemon (live sessions reject it and survive).
    const abortedStartupAdapter = new DaemonPtyAdapter({
      socketPath: info.socketPath,
      tokenPath: info.tokenPath
    })
    releaseDaemonAdoptionLease(newSpawner.getHandle())
    await abortedStartupAdapter.disconnectOnly()
    return
  }

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir(),
    // Why: on daemon death, ensureConnected() detects the dead socket and calls this to fork a replacement before retrying.
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(newSpawner.getHandle())
    }
  })
  let legacyAdapters: DaemonPtyAdapter[] = []
  let routedAdapter: DaemonProvider = newAdapter
  try {
    // Why: the launcher's temporary pair closes only after this permanent pair is established, leaving no adoption gap.
    await newAdapter.establishLifecycleLease()
    releaseDaemonAdoptionLease(newSpawner.getHandle())

    legacyAdapters = await createLegacyDaemonAdapters(runtimeDir)
    routedAdapter =
      launchMode === 'degraded-new-pty-fallback'
        ? new DegradedDaemonPtyProvider({
            current: newAdapter,
            legacy: legacyAdapters,
            fallback: getLocalPtyProvider()
          })
        : legacyAdapters.length > 0
          ? new DaemonPtyRouter({
              current: newAdapter,
              legacy: legacyAdapters
            })
          : newAdapter
    if (routedAdapter instanceof DegradedDaemonPtyProvider) {
      // Why: preserved daemon can't create fresh terminals; discover its live session ids so only they route to it (fresh panes fall back locally).
      await routedAdapter.discoverDaemonSessions()
    } else if (routedAdapter instanceof DaemonPtyRouter) {
      await routedAdapter.discoverLegacySessions()
    }
    if (signal?.aborted) {
      // Why: same late-swap guard after legacy discovery; release uninstalled adapter leases without killing live sessions.
      await routedAdapter.disconnectOnly()
      return
    }
  } catch (error) {
    try {
      await cleanupFailedDaemonAdoption(newSpawner, newAdapter, legacyAdapters)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon adoption and cleanup both failed')
    }
    throw error
  }
  spawner = newSpawner
  adapter = routedAdapter
  setLocalPtyProvider(routedAdapter)
  // Why: the first window may register PTY listeners before daemon init finishes; rebind so daemon PTYs still fan out events.
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', { legacyAdapters: legacyAdapters.length })
  await reconcileSeededClaudeLivePtys(routedAdapter)
}

// Why: release gate ids only for daemon-confirmed-dead sessions; keep seeds on listing failure since releasing early can rotate a live CLI's refresh token.
async function reconcileSeededClaudeLivePtys(provider: DaemonProvider): Promise<void> {
  if (!hasSeededUnconfirmedClaudePtys()) {
    return
  }
  try {
    const adapters =
      provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
        ? provider.getAllAdapters()
        : [provider]
    const results = await Promise.allSettled(adapters.map((entry) => entry.listSessions()))
    if (results.some((result) => result.status === 'rejected')) {
      console.warn('[daemon] Keeping seeded Claude live-PTY gate — session listing failed')
      return
    }
    confirmSeededClaudeLivePtys(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.map((session) => session.sessionId) : []
      )
    )
  } catch (error) {
    // Why: gate bookkeeping must never fail daemon init; stale seeds only defer a usage refresh until next restart.
    console.warn('[daemon] Failed to reconcile seeded Claude live-PTY gate:', error)
  }
}

// Why: a narrow getter (not a raw export) keeps the "swap on restart" invariant in one place (replaceDaemonProvider).
export function getDaemonProvider(): DaemonProvider | null {
  return adapter
}

// Why: keep the module-level adapter and ipc/pty.ts's localProvider in sync so app-quit can't dispose a stale reference.
export function replaceDaemonProvider(newAdapter: DaemonProvider): void {
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
}

function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter {
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return provider.getCurrentAdapter()
  }
  return provider
}

function getLegacyDaemonAdapters(provider: DaemonProvider): DaemonPtyAdapter[] {
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return [...provider.getLegacyAdapters()]
  }
  return []
}

function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
    return
  }
  if (provider instanceof DegradedDaemonPtyProvider) {
    provider.disposeProviderOnly()
  }
}

export type RestartDaemonResult = {
  killedCount: number
}

// Why: the 7-step restart sequence from docs/daemon-staleness-ux.md §Phase 1; current-protocol only (legacy adapters preserved).
export async function restartDaemon(): Promise<RestartDaemonResult> {
  if (restartInFlight) {
    return restartInFlight
  }
  restartInFlight = runRestartDaemon().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}

async function runRestartDaemon(): Promise<RestartDaemonResult> {
  const currentSpawner = spawner
  const currentAdapter = adapter
  if (!currentSpawner || !currentAdapter) {
    throw new Error('restartDaemon called before initDaemonPtyProvider')
  }

  const runtimeDir = getRuntimeDir()
  const currentOnly = getCurrentDaemonAdapter(currentAdapter)
  const legacyAdapters = getLegacyDaemonAdapters(currentAdapter)

  // Step 1: synthesize pty:exit for every active session BEFORE teardown — the daemon's shutdown path never fans onExit to clients (session.ts:246-252), so the renderer would otherwise never see exits.
  const fallbackKilledCount =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? await currentAdapter.shutdownFallbackSessions()
      : 0
  const currentDaemonSessionIds =
    currentAdapter instanceof DegradedDaemonPtyProvider
      ? currentAdapter.getCurrentDaemonSessionIds()
      : []
  const killedCount =
    new Set([...currentOnly.getActiveSessionIds(), ...currentDaemonSessionIds]).size +
    fallbackKilledCount
  currentOnly.fanoutSyntheticExits(-1)
  if (currentAdapter instanceof DegradedDaemonPtyProvider) {
    currentAdapter.fanoutCurrentDaemonSyntheticExits(-1)
  }

  // Step 2: detach renderer listeners — after step 1 (so synthesized exits land) and before step 6 (no stale binding).
  unbindLocalProviderListeners()

  // Step 3: kill the current-protocol daemon process; legacy adapters untouched.
  let info: Awaited<ReturnType<DaemonSpawner['ensureRunning']>>
  try {
    await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)

    // Step 4: reuse the existing spawner so the respawn closure baked into long-lived adapters stays valid (do NOT new one).
    currentSpawner.resetHandle()
    info = await currentSpawner.ensureRunning()
  } catch (error) {
    // Why: old provider stays authoritative until the final swap; rebind since relaunch failed after teardown.
    rebindLocalProviderListeners()
    throw error
  }

  // Step 5: build a fresh current adapter against the respawned daemon.
  const newCurrent = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir(),
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      currentSpawner.resetHandle()
      await currentSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(currentSpawner.getHandle())
    }
  })
  let newProvider: DaemonProvider = newCurrent
  try {
    // Temporary launcher lease overlaps this permanent pair so a manual restart can't strand a newly spawned daemon during adoption.
    await newCurrent.establishLifecycleLease()
    releaseDaemonAdoptionLease(currentSpawner.getHandle())

    // Re-wrap in a router only if legacy adapters exist; they're preserved by reference and still route to their pre-upgrade daemons.
    newProvider =
      legacyAdapters.length > 0
        ? new DaemonPtyRouter({ current: newCurrent, legacy: legacyAdapters })
        : newCurrent
    if (newProvider instanceof DaemonPtyRouter) {
      await newProvider.discoverLegacySessions()
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      if (newProvider instanceof DaemonPtyRouter) {
        newProvider.disposeRouterOnly()
      }
      await cleanupFailedDaemonAdoption(currentSpawner, newCurrent)
    } catch (caught) {
      cleanupError = caught
    }
    // Previous provider stays module-authoritative until the swap; restore its renderer bindings when adoption fails.
    rebindLocalProviderListeners()
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon restart and cleanup both failed')
    }
    throw error
  }

  // Drain the old router's subscriptions via the router-only variant (plain dispose() would tear down the shared legacy adapters), after the new provider exists (no unhandled events) and before the swap (atomic for the renderer).
  disposeProviderSubscriptionsOnly(currentAdapter)

  // Step 6: swap module state (adapter + localProvider) atomically.
  replaceDaemonProvider(newProvider)

  // Step 7: rebind renderer listeners against the new provider.
  rebindLocalProviderListeners()

  return { killedCount }
}

// Disconnect without killing: the daemon survives app quit so sessions stay warm for reattach.
// Leave history sessions marked "unclean" so a daemon crash while Orca is closed stays recoverable.
export async function disconnectDaemon(): Promise<void> {
  await adapter?.disconnectOnly()
  adapter = null
}

/** Kill the daemon and all its sessions. Use for full cleanup only. */
export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  await spawner?.shutdown()
  spawner = null
}

export type OrphanedDaemonCleanupResult = {
  /** True when a live daemon socket was found and torn down; false when none was running. */
  cleaned: boolean
  /** Number of live PTY sessions killed during cleanup (surfaced to the user). */
  killedCount: number
}

export async function cleanupDaemonForProtocol(
  runtimeDir: string,
  protocolVersion: number
): Promise<OrphanedDaemonCleanupResult> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)

  const alive = await probeSocket(socketPath)
  if (!alive) {
    if (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      // Endpoint absence doesn't prove the PID record belongs to the current protocol; leave artifact cleanup to the owning daemon.
      return { cleaned: false, killedCount: 0 }
    }
    // Best-effort remove a stale socket so a future launch doesn't hit EADDRINUSE on bind.
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort
      }
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // Best-effort
    }
    return { cleaned: false, killedCount: 0 }
  }

  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  let killedCount = 0
  let didRequestShutdown = false
  let didKillStaleDaemon = false
  try {
    await client.ensureConnected()
    const sessions = await client
      .request<ListSessionsResult>('listSessions', undefined)
      .catch(() => ({ sessions: [] }))
    killedCount = sessions.sessions.filter((s) => s.isAlive).length

    // Use the single-shot `shutdown` RPC (kills all sessions then exits) to avoid racing per-session `kill` calls against the daemon exiting.
    await client.request('shutdown', { killSessions: true }).catch(() => {
      // Daemon exits immediately after the RPC, so the socket may close before the reply arrives; treat as success.
    })
    didRequestShutdown = true
  } catch {
    // Previous-protocol daemons may be wedged or too old for the RPC path; fall back to PID cleanup (only unlinks a live socket after proving the process is killed).
    didKillStaleDaemon = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
  } finally {
    client.disconnect()
  }

  if (didRequestShutdown && protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
    if (!(await waitForDaemonEndpointExit(socketPath))) {
      // Never fork a replacement while the old incarnation may still own the endpoint or be disposing terminal children.
      throw new Error('Timed out waiting for daemon self-shutdown')
    }
    return { cleaned: true, killedCount }
  }

  // Defensively unlink the socket: the daemon normally removes it after `shutdown`, but on some crash paths it lingers and blocks a later rebind.
  if (didRequestShutdown && process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Best-effort
    }
  }
  try {
    unlinkSync(pidPath)
  } catch {
    // Best-effort
  }

  return { cleaned: didRequestShutdown || didKillStaleDaemon, killedCount }
}

async function waitForDaemonEndpointExit(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + DAEMON_SELF_SHUTDOWN_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await probeSocket(socketPath))) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !(await probeSocket(socketPath))
}

function legacyDaemonProcessMayBeAlive(runtimeDir: string, protocolVersion: number): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch {
    return false
  }
}

async function createLegacyDaemonAdapters(runtimeDir: string): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      // Why: a recycled stale pid later turns an identity check into a PowerShell spawn, so delete leaked pid/token files — but only when the pid-process is provably gone (a live daemon can transiently fail the probe, and dropping its token makes its sessions permanently unadoptable).
      if (!legacyDaemonProcessMayBeAlive(runtimeDir, protocolVersion)) {
        for (const stalePath of [
          getDaemonPidPath(runtimeDir, protocolVersion),
          getDaemonTokenPath(runtimeDir, protocolVersion)
        ]) {
          try {
            unlinkSync(stalePath)
          } catch {
            // Best-effort
          }
        }
        if (process.platform !== 'win32' && existsSync(socketPath)) {
          try {
            unlinkSync(socketPath)
          } catch {
            // Best-effort
          }
        }
      }
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion,
        historyPath: getHistoryDir()
      })
    )
  }
  return adapters
}
