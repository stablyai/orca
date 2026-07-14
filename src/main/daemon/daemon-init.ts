/* eslint-disable max-lines -- Why: this module owns the complete daemon
lifecycle for the Electron main process — init, out-of-process launch,
current+legacy adapter wiring, restart orchestration (the 7-step sequence
from docs/daemon-staleness-ux.md §Phase 1), and teardown on app quit. Splitting
it would scatter the "swap the running provider atomically" invariant across
files with no cleaner ownership seam: restart, replaceDaemonProvider, and the
module-level spawner/adapter singletons must stay co-located so a future
change cannot leave them drifting out of sync. */
import { join } from 'node:path'
import { app } from 'electron'
import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fork } from 'node:child_process'
import { connect } from 'node:net'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  serializeDaemonPidFile,
  type DaemonLauncher,
  type DaemonProcessHandle
} from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonClient } from './client'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type ListSessionsResult
} from './types'
import {
  getMacDaemonSystemResolverHealth,
  getDaemonLaunchIdentity,
  getProcessStartedAtMs,
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

// Why: daemon init runs concurrently with window load, so harness-side stderr
// arrival times are useless — in-process `t` lets the startup benchmark derive
// how long the daemon cold-start path actually took.
function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}

// Why: how many extra hello+listSessions probes to make against a wedged-but-
// connectable daemon before replacing it. Each probe waits out the client's 5s
// hello timeout, so this spaces re-checks ~5s apart: 1 initial + 11 retries ≈
// 60s of grace for a transiently wedged daemon (Windows update-relaunch drain)
// to answer and be preserved WITH its live sessions, before a permanent wedge
// (#8689) is replaced. Deliberately generous to keep live-session loss on the
// transient path as close to zero as possible.
//
// A transient wedge drains early (well under the 60s local-PTY fail-open cap),
// so its startup is short. Only a *permanent* wedge runs the full window; it can
// then approach/exceed the fail-open cap, at which point restored panes fail
// open to the in-process provider for the session and adopt the freshly forked
// daemon on the next launch — a rare path that still recovers, versus the old
// forever-broken behavior. Trade-off: a transient wedge owning live sessions
// that takes longer than ~60s to drain is replaced (live processes lost, though
// scrollback cold-restores). Raise this only alongside the fail-open cap.
export const WEDGED_DAEMON_GRACE_RETRIES = 11

let spawner: DaemonSpawner | null = null
type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider

let adapter: DaemonProvider | null = null
// Why: coalesce concurrent restartDaemon() calls so two clicks (or a UI
// click racing an internal caller) can't both enter the 7-step sequence —
// the second entry would read the already-disposed current adapter and
// race cleanupDaemonForProtocol against a half-spawned replacement.
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
  // Why: electron-builder unpacks daemon-entry.js so child_process.fork() can
  // execute it from disk. In packaged apps app.getAppPath() points at
  // app.asar, so redirect to the unpacked sibling before joining the script.
  const basePath = app.isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'daemon-entry.js')
}

// Why: the detached daemon writes lifecycle events to a rotated file so field
// failures are diagnosable from a bundle. Honor the same hard privacy switch
// the local trace sink honors (ORCA_DIAGNOSTICS_DISABLED); absence of the arg
// is fully supported, so gating it off is safe and adoption-neutral.
function daemonLogArgs(): string[] {
  const disabled = (process.env.ORCA_DIAGNOSTICS_DISABLED ?? '').trim().toLowerCase()
  if (disabled === '1' || disabled === 'true') {
    return []
  }
  return ['--log-file', getDaemonLogFilePath()]
}

// Why: before spawning a new daemon, check if an existing one is alive by
// attempting a TCP connection to the socket. If it connects, the daemon
// survived from a previous app session — reuse it instead of spawning.
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
  return async (socketPath, tokenPath) => {
    const entryPath = getDaemonEntryPath()
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
          return createPreservedDaemonHandle(runtimeDir)
        }
        console.warn('[daemon] Replacing daemon with unavailable macOS system resolver')
        await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
      } else {
        // Why: a protocol-healthy daemon can outlive the app bundle that
        // launched it. In dev this happens after deleting/rebuilding a
        // worktree; in packaged apps it happens when the stable
        // /Applications/Orca.app path is replaced during update.
        const identity = await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
        const stalePackagedBundle =
          app.isPackaged &&
          (await isDaemonStaleForCurrentBundle(runtimeDir, socketPath, tokenPath, app.getVersion()))
        if (identity === 'mismatch' || stalePackagedBundle) {
          // Why: replacing a healthy daemon kills its child PTYs; defer code
          // freshness until no live terminal sessions would be lost.
          const replacementLabel = stalePackagedBundle
            ? 'launched before the current app bundle was installed'
            : 'launched from a different app path'
          if (await shouldPreserveDaemonWithLiveSessions(socketPath, tokenPath, replacementLabel)) {
            return createPreservedDaemonHandle(runtimeDir)
          }
          console.warn(
            stalePackagedBundle
              ? '[daemon] Replacing daemon launched before the current app bundle was installed'
              : '[daemon] Replacing daemon launched from a different app path'
          )
          await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
        } else {
          // Why: daemon is already running from a previous app session and
          // responded to a protocol-level ping. Safe to reuse.
          return createPreservedDaemonHandle(runtimeDir)
        }
      }
    } else {
      // Why: a busy machine (e.g. right after an update) can time out the
      // health check while the daemon is alive and owning terminals. Killing
      // it would destroy every live session, so re-verify with a session list
      // first.
      let liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
      // Why: on a Windows update relaunch the daemon can be transiently wedged
      // past every RPC budget (final checkpoint flush + installer/AV disk
      // pressure) while its sessions are still alive — replacing it here is what
      // killed those sessions. A pipe that still accepts connections proves a
      // live daemon, so give a wedged-but-connectable daemon a bounded grace to
      // drain and answer before deciding. A PERMANENTLY wedged daemon (accepts
      // connections but its event loop never answers hello — #8689) exhausts the
      // grace and falls through to replacement below, instead of being preserved
      // forever, which strands the app with zero working terminals. 'rejected'
      // means the daemon answered and refused the handshake — it can never be
      // adopted, so it skips the grace and replacement stays the only recovery.
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
          return createPreservedDaemonHandle(
            runtimeDir,
            PROTOCOL_VERSION,
            'degraded-new-pty-fallback'
          )
        }
        console.warn(
          `[daemon] Preserving daemon that failed the health check because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
        )
        return createPreservedDaemonHandle(runtimeDir)
      }
    }

    // Why: a raw socket can outlive a broken or wedged daemon. Kill by PID
    // before respawn so the new daemon does not race the stale process.
    await killStaleDaemon(runtimeDir, socketPath, tokenPath)

    const userDataPath = app.getPath('userData')
    // Why: on win32 packaged, fork from a copy of the Electron runtime staged
    // in userData so the daemon's image + loaded modules escape the install dir
    // the NSIS updater deletes and force-closes. Staged here (not at app start)
    // so the one-time copy stays off the first-paint path and is skipped on
    // launches that adopt a live daemon. Fail-open: null → in-dir host, below.
    const relocatedHost = materializeRelocatedDaemonHost()
    // Fork the relocated entry when available; otherwise the install-dir entry.
    const forkEntryPath = relocatedHost ? relocatedHost.entryPath : entryPath
    const child = fork(
      forkEntryPath,
      ['--socket', socketPath, '--token', tokenPath, ...daemonLogArgs()],
      {
        // Why: detached daemons can outlive dev worktrees. Starting from
        // userData keeps process.cwd() valid after a repo/worktree is deleted.
        cwd: userDataPath,
        // Why: detached + unref lets the daemon outlive the Electron process.
        // stdout stays 'ignore' so the child never holds the parent's stdout
        // open (which would block Electron exit); stderr is 'pipe' so a
        // module-load crash during startup is captured instead of discarded
        // (v1.4.129-rc.1 shipped a daemon that only logged "exited with code 1"
        // because stderr was thrown away). The pipe is destroyed on readiness.
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        // Why: run the relocated Orca.exe copy instead of the install-dir one.
        // It is byte-identical, so run-as-node behavior is unchanged; only the
        // image path moves out of the updater's kill zone.
        ...(relocatedHost ? { execPath: relocatedHost.execPath } : {}),
        // Why: ELECTRON_RUN_AS_NODE makes the forked process run as a plain
        // Node.js process instead of an Electron renderer/main process. Without
        // it, Electron's GPU/display initialization can interfere with native
        // module operations like node-pty's posix_spawn of the spawn-helper.
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // Why: the detached daemon is plain Node and cannot call Electron's
          // app.getPath(), but shell-ready rcfiles must live outside swept tmp.
          ORCA_USER_DATA_PATH: userDataPath
        }
      }
    )

    // Why: keep only the startup-window stderr tail so a crash cause is
    // visible without unbounded memory if the daemon spews before dying.
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
    // Why: once the daemon is up (or has failed) the parent must not keep a
    // live handle on the detached daemon's stderr — a piped stream would ref
    // the parent event loop and prevent Electron from exiting cleanly.
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
      function fail(error: Error): void {
        if (settled) {
          return
        }
        settled = true
        cleanupStartupListeners()
        // Why: stderr was previously discarded, so a startup crash surfaced only
        // as "exited with code 1". Attach the captured tail to the thrown error
        // (which the fallback path reports) and log it so the real cause shows.
        const stderrTail = startupStderr.trim()
        if (stderrTail) {
          console.warn(`[daemon] startup failed; captured stderr tail:\n${stderrTail}`)
        }
        releaseStderr()
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
        reject(
          stderrTail ? new Error(`${error.message}\nDaemon stderr (tail):\n${stderrTail}`) : error
        )
      }
      function onReadyMessage(msg: unknown): void {
        if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
          if (settled) {
            return
          }
          settled = true
          // Why: the daemon process is detached after readiness; leaving
          // startup listeners attached retains this launch promise closure.
          cleanupStartupListeners()
          if (child.pid) {
            // Why: JSON pid file carries pid + process start time so later
            // killStaleDaemon() can verify the pid still belongs to the daemon
            // we forked before SIGTERMing it. Prevents pid-recycling hazard
            // where the OS hands the daemon's old pid to an unrelated process.
            // Why the ready-message fallback: Windows has no cheap OS query
            // for start time, so the daemon self-reports it — without this the
            // recycling guard was permanently inert on win32.
            const selfReported = (msg as { startedAtMs?: unknown }).startedAtMs
            writeFileSync(
              getDaemonPidPath(runtimeDir),
              serializeDaemonPidFile({
                pid: child.pid,
                startedAtMs:
                  getProcessStartedAtMs(child.pid) ??
                  (typeof selfReported === 'number' && Number.isFinite(selfReported)
                    ? selfReported
                    : null),
                entryPath,
                appVersion: app.getVersion()
              }),
              { mode: 0o600 }
            )
          }
          // Why: disconnect IPC channel, release the stderr pipe, and unref so
          // Electron can exit without waiting for the daemon. The daemon keeps
          // running detached.
          releaseStderr()
          child.disconnect()
          child.unref()
          resolve()
        }
      }

      function onStartupError(err: Error): void {
        fail(err)
      }

      function onStartupExit(code: number | null): void {
        fail(new Error(`Daemon exited during startup with code ${code}`))
      }

      timer = setTimeout(() => {
        fail(new Error('Daemon startup timed out'))
      }, 10000)

      child.on('message', onReadyMessage)
      child.on('error', onStartupError)
      child.on('exit', onStartupExit)
    })

    return {
      shutdown: async () => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
      }
    }
  }
}

export async function initDaemonPtyProvider(signal?: AbortSignal): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Why: e2e coverage for the startup PTY gate (#5232) needs a daemon init
  // that deterministically outlasts the first-window timeout. Real triggers
  // (stale-daemon cleanup, legacy probes on a busy disk) are not controllable
  // from a test.
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir)
  })

  // Why: assign spawner/adapter only after both succeed. If ensureRunning()
  // throws, a stale spawner would prevent shutdownDaemon() from cleaning up
  // correctly on retry.
  const info = await newSpawner.ensureRunning()
  // Reclaim superseded daemon-host copies on EVERY launch, not just on a fresh
  // spawn: surviving daemons make spawns rare, so a spawn-only sweep would let
  // old-version copies accumulate. Current + live-daemon-pinned versions stay.
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  logDaemonMilestone('daemon-current-ready')
  if (signal?.aborted) {
    // Why: startup fail-open may already have allowed fallback LocalPtyProvider
    // PTYs to spawn. A late daemon swap would strand those PTYs on the old owner.
    return
  }

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir(),
    // Why: when the daemon process dies (e.g. killed by a signal, OOM, or
    // cascading from a force-quit of child processes), the adapter's
    // ensureConnected() detects the dead socket and calls this to fork a
    // replacement daemon before retrying the connection.
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
    }
  })

  const legacyAdapters = await createLegacyDaemonAdapters(runtimeDir)
  const routedAdapter =
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
    // Why: the preserved daemon cannot create fresh terminals, but its live
    // sessions may still be writable. Discover those ids so only known old
    // sessions route to the degraded daemon; fresh panes fall back locally.
    await routedAdapter.discoverDaemonSessions()
  } else if (routedAdapter instanceof DaemonPtyRouter) {
    await routedAdapter.discoverLegacySessions()
  }
  if (signal?.aborted) {
    // Why: same late-swap guard after legacy discovery, which can also exceed
    // the first-window startup timeout on slow or stale daemon state.
    return
  }

  spawner = newSpawner
  adapter = routedAdapter
  setLocalPtyProvider(routedAdapter)
  // Why: desktop startup now lets the first window register PTY listeners
  // before daemon init finishes. Rebind here so daemon PTYs still fan out
  // data/exit events through the renderer and runtime listeners.
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', { legacyAdapters: legacyAdapters.length })
  await reconcileSeededClaudeLivePtys(routedAdapter)
}

// Why: the Claude live-PTY gate is seeded pessimistically from persistence at
// store load. Once the daemon is up we know which of those sessions actually
// survived — release dead ids so they cannot defer OAuth refresh forever.
// Listing failures keep the seeds: over-holding the gate only delays a usage
// refresh, while releasing it early can rotate a live CLI's refresh token.
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
    // Why: gate bookkeeping must never fail daemon init; stale seeds only
    // defer a usage refresh until the next restart.
    console.warn('[daemon] Failed to reconcile seeded Claude live-PTY gate:', error)
  }
}

// Why: the Manage Sessions IPC handlers need read access to the current
// adapter/router to list sessions, kill them, etc. Exposed as a narrow getter
// rather than exporting the module-level variable to keep the "swap on
// restart" invariant in one place (replaceDaemonProvider).
export function getDaemonProvider(): DaemonProvider | null {
  return adapter
}

// Why: the "Restart daemon" flow rebuilds the current-protocol adapter and
// must update both the module-level `adapter` singleton here and the
// `localProvider` reference inside ipc/pty.ts. Without this helper they could
// drift — app-quit would dispose a stale adapter reference.
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

// Why: the 7-step sequence from docs/daemon-staleness-ux.md §Phase 1 restart.
// Current-protocol only — legacy adapters are preserved and route to their
// original daemons with no respawn path. See the design doc for rationale on
// each step, notably why synthetic exits must fan out *before* the listener
// unsubscribe.
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

  // Step 1: synthesize pty:exit for every active session on the current
  // adapter BEFORE any teardown. The daemon's kill-all-and-shutdown path
  // explicitly does not fan onExit to clients (session.ts:246-252), so
  // without this the renderer would never see exits and would black-hole
  // writes against the disposed adapter.
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

  // Step 2: detach renderer listeners from the current adapter. Must happen
  // AFTER step 1 so the synthesized exits actually reach the renderer, and
  // BEFORE step 6 so the new provider isn't bound with stale listeners.
  unbindLocalProviderListeners()

  // Step 3: kill the current-protocol daemon process (shutdown RPC → fallback
  // killStaleDaemon → socket/pid unlink). Legacy adapters untouched.
  await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)

  // Step 4: reuse the existing spawner so the respawn closure baked into
  // long-lived adapters stays valid. Do NOT construct a new DaemonSpawner.
  currentSpawner.resetHandle()
  const info = await currentSpawner.ensureRunning()

  // Step 5: build a fresh current adapter against the respawned daemon. Its
  // respawn callback closes over the same spawner instance (identical to the
  // crash-respawn closure in initDaemonPtyProvider).
  const newCurrent = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir(),
    respawn: async () => {
      console.warn('[daemon] Daemon process died — respawning')
      currentSpawner.resetHandle()
      await currentSpawner.ensureRunning()
    }
  })

  // Re-wrap in router if there were legacy adapters at startup; otherwise
  // point straight at the new adapter. Legacy instances are preserved by
  // reference — they still route to the same pre-upgrade daemons.
  const newProvider =
    legacyAdapters.length > 0
      ? new DaemonPtyRouter({ current: newCurrent, legacy: legacyAdapters })
      : newCurrent
  if (newProvider instanceof DaemonPtyRouter) {
    await newProvider.discoverLegacySessions()
  }

  // Why: drain the outgoing router's subscriptions from the shared legacy
  // adapters before installing the new router (which subscribes fresh). Must
  // run *after* the new provider exists so no adapter event is unhandled in
  // the narrow window, and *before* replaceDaemonProvider so the swap is
  // atomic from the renderer's perspective. Plain dispose() would also tear
  // down the legacy adapters themselves — use the router-only variant.
  disposeProviderSubscriptionsOnly(currentAdapter)

  // Step 6: swap module state (adapter + localProvider) atomically.
  replaceDaemonProvider(newProvider)

  // Step 7: rebind renderer listeners against the new provider.
  rebindLocalProviderListeners()

  return { killedCount }
}

// Why: disconnect from the daemon without killing it. The daemon runs as a
// separate process and survives app quit — sessions stay alive for warm
// reattach on next launch. Leave history sessions marked "unclean" here so a
// later daemon crash while Orca is closed is still recoverable on next launch.
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
  try {
    unlinkSync(getDaemonPidPath(getRuntimeDir()))
  } catch {
    // Best-effort
  }
}

export type OrphanedDaemonCleanupResult = {
  /** True when we detected a live daemon socket and connected to tear it down.
   *  False when no daemon was running (fresh install or clean previous quit). */
  cleaned: boolean
  /** Number of live PTY sessions killed during cleanup. The caller surfaces this
   *  to the user so they know what background work was stopped. */
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
    // Why: still best-effort remove a stale socket file so a future opt-in
    // launch doesn't hit EADDRINUSE when the daemon tries to bind.
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

    // Why: the daemon exposes a single-shot `shutdown` RPC (daemon-server.ts)
    // that kills every session and then terminates its own process. Using it
    // avoids the race between per-session `kill` calls and the daemon exiting.
    await client.request('shutdown', { killSessions: true }).catch(() => {
      // Daemon exits immediately after handling the RPC — the socket may close
      // before the reply round-trips. Treat that as success.
    })
    didRequestShutdown = true
  } catch {
    // Why: previous-protocol daemons may be wedged or too old to complete the
    // RPC cleanup path. Fall back to PID cleanup, but daemon-health only
    // unlinks a live socket after proving it killed the matching process.
    didKillStaleDaemon = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
  } finally {
    client.disconnect()
  }

  // Why: after `shutdown`, the daemon unlinks its socket itself — but on some
  // crash paths the file lingers. Clean up defensively so a later opt-in
  // relaunch can bind cleanly.
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
      // Why: dead legacy daemons leave pid/token files behind forever (one per
      // protocol bump). A stale pid eventually gets recycled by an unrelated
      // process, turning any future identity check into a PowerShell spawn.
      // Only clean up when the pid-file process is provably gone: a live
      // legacy daemon can transiently fail the 1s probe right after an update
      // (wedged event loop, exhausted pipe backlog), and deleting its token
      // file would make its sessions permanently unadoptable.
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
    // Why: old daemon PTYs can be running long-lived agents during an app
    // upgrade. Keep those sessions routed to their original daemon while new
    // terminals use the current protocol, instead of killing background work.
    // Legacy adapters intentionally do not respawn: respawning an old protocol
    // daemon from new code would recreate stale env semantics and can be less
    // predictable than letting the session fail if that old daemon dies.
    // Why historyPath is still passed: checkpoint writes will fail silently
    // (pre-v4 daemons don't support getSnapshot), but the HistoryManager is
    // still needed for cleanup — close/exit events must remove history dirs
    // and mark meta.json as ended. Without it, a later v4 session reusing
    // the same ID could false-restore stale scrollback.bin.
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
