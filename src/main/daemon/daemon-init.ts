/* eslint-disable max-lines -- Why: owns the full daemon lifecycle (init, launch, adapter wiring,
restart, teardown); the "swap the provider atomically" invariant keeps restart + singletons co-located. */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  replaceDaemonPidFile,
  unlinkOwnedDaemonPidFile,
  type DaemonLauncher,
  type DaemonPidFile,
  type DaemonLaunchMode,
  type DaemonProcessHandle
} from './daemon-spawner'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import {
  OCCUPANCY_CONNECT_BUDGET_MS,
  OCCUPANCY_REQUEST_BUDGET_MS,
  raiseOccupancyWithProcessEvidence,
  resolveDaemonOccupancy,
  type DaemonOccupancy
} from './daemon-occupancy'
import { DaemonPtyAdapter, type DaemonRespawnReason } from './daemon-pty-adapter'
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
  getMacDaemonTccAttributionHealth,
  getDaemonLaunchIdentity,
  checkDaemonHealth,
  isDaemonStaleForCurrentBundle,
  killStaleDaemon,
  readVerifiedDaemonPid,
  parseDaemonPidFile,
  type MacDaemonTccAttributionHealth
} from './daemon-health'
import {
  collectPinnedDaemonVersions,
  materializeRelocatedDaemonHost,
  pruneOldDaemonHosts
} from './daemon-host-relocation'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { trackDaemonReplaced, trackDaemonRetired } from './daemon-lifecycle-event'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
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
import { parseDaemonReadyIdentity, readDaemonProcessIncarnation } from './daemon-ready-identity'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

// Why: daemon init runs concurrent with window load, so an in-process t timestamp (not harness stderr timing) measures cold-start.
function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, {
      t: Math.round(performance.now()),
      ...details
    })
  }
}

/**
 * Ceiling on the whole failed-health classification — every probe, the grace window, the
 * identity check and the process-table read together — enforced at runtime rather than
 * summed by hand.
 *
 * Why enforced: startup fails open at 60s by abandoning the daemon provider outright, and
 * ensureRunning() is not abortable, so overrunning costs the app its daemon *and* still kills
 * the incumbent. Four separate reviews found a term missing from the hand-written sum that
 * was supposed to prevent that — the launcher's own adoption connect, an identity probe, an
 * endpoint probe, a doubled evidence deadline. A budget that has to be remembered is a budget
 * that will be wrong, so the code now spends against a clock and stops when it runs out.
 *
 * The remainder of the fail-open window belongs to what follows a replace verdict: the kill
 * ladder and the daemon fork.
 */
export const WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS = 34_000

/**
 * The clock the identity re-check and process-table read need, checked *after* the probes
 * rather than withheld from them.
 *
 * It used to be a reservation, and that was backwards: withholding twelve seconds starved the
 * one probe whose answer can still restore full daemon mode, since only a counted reply reaches
 * preserveDaemon(). With the reservation in place the "patient" ask resolved to exactly the
 * cheap ask's four seconds.
 *
 * Do not read the demotion as "the evidence read is cosmetic" — an earlier version of this
 * comment said that and it was wrong twice over. The read decides the verdict wherever the
 * unknown hold declines to: it has no endpointIsProvenDead check and no health !== 'rejected'
 * check, so evidence is what holds a daemon whose socket entry vanished, and what holds a
 * hello-rejected daemon that is still hosting agents. Skipping it on a spent clock therefore
 * withdraws real protection, not a log line; the gate is set so that only probes which already
 * consumed the budget can trigger it.
 *
 * So the evidence read is opportunistic now. If the probes used the clock, it is skipped and
 * the verdict stays 'unknown' — which holds the daemon exactly as an evidence-raised
 * 'occupied' would have. Nothing is lost but a more precise log line.
 *
 * Zero on Windows, which runs neither step.
 */
export const CLASSIFICATION_EVIDENCE_MIN_MS = process.platform === 'win32' ? 0 : 12_000
const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000
const DAEMON_CHILD_TERMINATION_GRACE_MS = 5_000
const DAEMON_CHILD_FORCE_EXIT_WAIT_MS = 1_000

class DaemonEndpointOwnershipError extends Error {}

/**
 * The one method the ownership checks need from a connected client.
 *
 * Why: naming the capability instead of casting DaemonClient to Partial keeps a rename from
 * silently turning the fence into a no-op — the compiler now rejects a client without it.
 */
type DaemonEndpointIdentityReader = {
  getDaemonIdentity?: () => DaemonEndpointIdentity | null
}

function readDaemonEndpointIdentity(
  client: DaemonEndpointIdentityReader
): DaemonEndpointIdentity | null {
  return client.getDaemonIdentity?.() ?? null
}

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

function createPreservedDaemonHandle(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  mode?: DaemonLaunchMode
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
  connectedClient?: DaemonClient,
  expectedIdentity?: DaemonEndpointIdentity,
  pidPath?: string
): Promise<DaemonProcessHandle> {
  const client = connectedClient ?? new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    if (expectedIdentity) {
      const actualIdentity = readDaemonEndpointIdentity(client)
      if (
        !actualIdentity ||
        actualIdentity.pid !== expectedIdentity.pid ||
        actualIdentity.startedAtMs !== expectedIdentity.startedAtMs ||
        actualIdentity.launchNonce !== expectedIdentity.launchNonce
      ) {
        throw new DaemonEndpointOwnershipError('Daemon endpoint ownership changed during startup')
      }
    }
    await reconcileDaemonPidOwnership(client, pidPath)
  } catch (error) {
    client.disconnect()
    throw error
  }
  handle.releaseAdoptionLease = () => client.disconnect()
  return handle
}

async function reconcileDaemonPidOwnership(
  client: DaemonEndpointIdentityReader,
  pidPath?: string
): Promise<void> {
  const endpointIdentity = readDaemonEndpointIdentity(client)
  if (!pidPath || !endpointIdentity || pidRecordMatchesEndpoint(pidPath, endpointIdentity)) {
    return
  }
  // Why: the mismatched record's metadata describes a different daemon and must not be copied
  // onto this one. Re-derive it from the authenticated owner instead, so the repaired record
  // keeps the fields freshness, host pinning and pid-recycle detection depend on.
  const { pid, startedAtMs, launchNonce } = endpointIdentity
  const ownerMetadata = await readDaemonOwnerMetadata(endpointIdentity)
  if (!replaceDaemonPidFile(pidPath, { pid, startedAtMs, launchNonce, ...ownerMetadata })) {
    // Why: fail open. A record that disagrees with the endpoint is a diagnosable nuisance;
    // abandoning a healthy adoptable daemon over a failed file write costs the user every
    // persistent terminal on the machine.
    console.warn(
      '[daemon] Could not repair daemon PID ownership; adopting the authenticated endpoint anyway'
    )
    return
  }
  console.warn('[daemon] Repaired daemon PID ownership to match the authenticated endpoint')
}

/**
 * Recovers the owning daemon's launch metadata.
 *
 * Why: `entryPath`/`appVersion` gate bundle-freshness and (on Windows) which relocated daemon
 * host directories are pinned against pruning, and the Linux pair gates pid-recycle detection.
 * Publishing a repaired record without them makes a healthy daemon look permanently stale.
 * The values come from the authenticated hello rather than the owner's command line: a command
 * line is a single space-joined string, so any install path containing a space (`C:\Program
 * Files\...`, `/Applications/Orca 2.app/...`) cannot be split back into argv unambiguously.
 */
async function readDaemonOwnerMetadata(
  identity: DaemonEndpointIdentity
): Promise<Partial<DaemonPidFile>> {
  const metadata: Partial<DaemonPidFile> = {}
  if (identity.entryPath) {
    metadata.entryPath = identity.entryPath
  }
  if (identity.appVersion) {
    metadata.appVersion = identity.appVersion
  }
  if (identity.spawnerExecPath) {
    metadata.spawnerExecPath = identity.spawnerExecPath
  }
  const incarnation = await readDaemonProcessIncarnation(identity.pid)
  if (incarnation) {
    metadata.linuxStartTicks = incarnation.linuxStartTicks
    metadata.bootId = incarnation.bootId
  }
  return metadata
}

function pidRecordMatchesEndpoint(pidPath: string, identity: DaemonEndpointIdentity): boolean {
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as {
      pid?: unknown
      startedAtMs?: unknown
      launchNonce?: unknown
    }
    return (
      record.pid === identity.pid &&
      record.startedAtMs === identity.startedAtMs &&
      record.launchNonce === identity.launchNonce
    )
  } catch {
    return false
  }
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

/** How a preserve decision reads in a log line, from either evidence source. */
function describeOccupancy(occupancy: DaemonOccupancy): string {
  if (occupancy.liveSessions === null) {
    return 'live session state could not be verified'
  }
  return `it owns ${occupancy.liveSessions} live session${occupancy.liveSessions === 1 ? '' : 's'}`
}

/** IPC only: these callers run against a daemon that just answered a health check. */
function resolveOccupancyOverIpc(socketPath: string, tokenPath: string): Promise<DaemonOccupancy> {
  return resolveDaemonOccupancy({ socketPath, tokenPath, recordedPid: null })
}

async function shouldPreserveDaemonWithLiveSessions(
  socketPath: string,
  tokenPath: string,
  replacementLabel: string
): Promise<boolean> {
  const occupancy = await resolveOccupancyOverIpc(socketPath, tokenPath)
  if (occupancy.state === 'empty') {
    return false
  }
  console.warn(
    `[daemon] Preserving daemon ${replacementLabel} because ${describeOccupancy(occupancy)}`
  )
  return true
}

// Why: the adapter decides a runtime resolver replacement, but the launcher completes it — and by
// then the daemon has usually self-retired (dropping its last authenticated client is enough), so
// there is nothing left to kill and the launcher's own confirmed-kill gate would report nothing.
// The adapter hands the reason across so the launch it triggers reports what actually drove it.
let attributedReplaceReason: DaemonReplaceReason | null = null

function createOutOfProcessLauncher(
  runtimeDir: string,
  macosLoginSessionWatch = false
): DaemonLauncher {
  return async (socketPath, tokenPath, suppliedPidPath, suppliedLaunchNonce) => {
    const entryPath = getDaemonEntryPath()
    const pidPath = suppliedPidPath ?? getDaemonPidPath(runtimeDir)
    const launchNonce = suppliedLaunchNonce ?? randomUUID()
    // One-shot: whichever launch consumes it owns the attribution, so a later unrelated launch can't
    // reuse it. The write in the respawn closure reaches here without an intervening await, which is
    // what makes a bare module-scoped slot safe — keep it that way or a concurrent launch can steal it.
    const attributedReason = attributedReplaceReason
    attributedReplaceReason = null
    let pendingReplacement:
      | {
          reason: Parameters<typeof trackDaemonReplaced>[0]
          liveSessionCount: number | null
          /** Rendered once the outcome is known; only the health-check branch announces. */
          verdict?: string
          announce?: boolean
        }
      | undefined
    let confirmedReplacement = false
    let adoptionClient: DaemonClient | null = new DaemonClient({
      socketPath,
      tokenPath
    })
    // Why the clock starts before the adoption connect: that connect is on the classification
    // path and uses the non-shared five-seconds-per-step default, so it was the fourth term to
    // go missing from the sum this replaces. A ceiling that starts after part of the work is
    // the same fiction in a new place.
    const classificationDeadline = Date.now() + WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS
    const classificationRemainingMs = (): number => Math.max(0, classificationDeadline - Date.now())
    try {
      // Why: acquire the full pair before control-only probes so an expired inherited deadline can't fire in the probe-to-adoption gap.
      // Capped: this only acquires a lease that preserveDaemon() re-establishes anyway, and a
      // daemon that accepts the socket but never answers hello would otherwise spend the whole
      // classification clock here, leaving nothing for the probes that protect its sessions.
      await adoptionClient.ensureConnectedWithin(
        Math.min(OCCUPANCY_CONNECT_BUDGET_MS, classificationRemainingMs())
      )
      await reconcileDaemonPidOwnership(adoptionClient, pidPath)
    } catch {
      adoptionClient.disconnect()
      adoptionClient = null
    }
    /**
     * Keep the incumbent without talking to it. No adoption, so no lease: the lease only
     * cancels an adoption watchdog, which cannot fire on a daemon that owns sessions.
     */
    const holdIncumbentDaemon = (): DaemonProcessHandle => {
      adoptionClient?.disconnect()
      adoptionClient = null
      return createPreservedDaemonHandle(runtimeDir, PROTOCOL_VERSION, 'held')
    }
    const preserveDaemon = async (mode?: DaemonLaunchMode): Promise<DaemonProcessHandle> => {
      const connectedClient = adoptionClient ?? undefined
      adoptionClient = null
      return holdDaemonAdoptionLease(
        createPreservedDaemonHandle(runtimeDir, PROTOCOL_VERSION, mode),
        socketPath,
        tokenPath,
        connectedClient,
        undefined,
        pidPath
      )
    }
    try {
      const health = await checkDaemonHealth(socketPath, tokenPath)
      if (health === 'healthy') {
        const resolverHealth = await getMacDaemonSystemResolverHealth(socketPath, tokenPath)
        if (resolverHealth === 'unhealthy') {
          const occupancy = await resolveOccupancyOverIpc(socketPath, tokenPath)
          if (occupancy.state !== 'empty') {
            console.warn(
              `[daemon] Preserving daemon with unavailable macOS system resolver because ${describeOccupancy(occupancy)}`
            )
            return preserveDaemon()
          }
          console.warn('[daemon] Replacing daemon with unavailable macOS system resolver')
          pendingReplacement = {
            reason: 'unhealthy_resolver',
            liveSessionCount: 0
          }
          confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION))
            .cleaned
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
            // liveSessionCount is 0: shouldPreserveDaemonWithLiveSessions() only falls through at exactly 0.
            pendingReplacement = {
              reason: stalePackagedBundle ? 'stale_bundle' : 'different_app_path',
              liveSessionCount: 0
            }
            confirmedReplacement = (await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION))
              .cleaned
          } else {
            const attributionHealth = await getMacDaemonTccAttributionHealth(
              runtimeDir,
              socketPath,
              tokenPath,
              app.isPackaged ? app.getVersion() : null
            )
            if (attributionHealth === 'severed') {
              // Why: replacing with live sessions would kill them; Settings → Developer
              // Permissions surfaces the Manage Sessions → Restart remedy instead.
              const occupancy = await resolveOccupancyOverIpc(socketPath, tokenPath)
              if (occupancy.state === 'empty') {
                console.warn(
                  '[daemon] Replacing daemon whose macOS TCC attribution is severed (spawning app binary no longer exists)'
                )
                pendingReplacement = { reason: 'severed_tcc_attribution', liveSessionCount: 0 }
                confirmedReplacement = (
                  await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)
                ).cleaned
              } else {
                return preserveDaemon()
              }
            } else {
              // Why: healthy daemon from a previous session answered a protocol ping — safe to reuse.
              return preserveDaemon()
            }
          }
        }
      } else {
        // Why: a busy machine can time out the health check on a live daemon; re-verify what
        // it is hosting before killing its sessions.
        //
        // No recordedPid: this loop waits for *IPC* to recover, and the process table cannot
        // change its answer within a grace window, so scanning it every pass would multiply
        // the launch budget for an answer we already have. It is read once, after the wait.
        // Every probe spends the shared clock, minus what the evidence read still needs, so no
        // probe can eat the reserve however long the daemon takes to answer.
        const probeBudgetMs = (): number => classificationRemainingMs()
        const askDaemonWhatItHosts = (connectBudgetMs: number): Promise<DaemonOccupancy> =>
          resolveDaemonOccupancy({
            socketPath,
            tokenPath,
            recordedPid: null,
            budgetMs: probeBudgetMs(),
            connectBudgetMs
          })
        // Why the tolerant question goes first: this path is only reached because a 3s health
        // check timed out, so a cheap probe re-asks on a stricter budget than the one that
        // triaged the daemon here and can only ever agree with it. The patient ask is the only
        // one that can disagree, and asking it last meant asking it with the clock already
        // spent. It gets every millisecond the answer itself does not still need, and never
        // less than the cheap ask would have had.
        const patientConnectBudgetMs = (): number =>
          Math.max(OCCUPANCY_CONNECT_BUDGET_MS, probeBudgetMs() - OCCUPANCY_REQUEST_BUDGET_MS)
        let occupancy = await askDaemonWhatItHosts(patientConnectBudgetMs())
        // Why there is no retry loop here any more. Cheap retries used to follow this ask, but
        // the arithmetic makes them unreachable at every ceiling, not just this one:
        //
        //   remaining = B - E - max(CONNECT, (B - E) - REQUEST) = REQUEST, whenever B - E > CONNECT + REQUEST
        //
        // The patient connect takes every millisecond the answer does not need, so what is left
        // after it is always exactly OCCUPANCY_REQUEST_BUDGET_MS — never enough to fund another
        // ask. Raising the budget donates the increase to the same connect and changes nothing.
        // Funding a real retry needs ~71s of classification, kill ladder and fork against a 60s
        // fail-open, so the loop cannot be bought back at any price.
        //
        // One shape did reach it, and the earlier claim that none could was wrong: a connect
        // that fails *fast* leaves the budget nearly whole, and while a refused or missing
        // endpoint is caught by the proven-dead guard, the EPERM/EMFILE class reads 'unknown'
        // and would have passed. Dropping it costs that case a retry — which retrying was never
        // going to fix, because an fd-exhausted or permission-denied connect fails the same way
        // the second time, and recover() puts the daemon back into full service on the next
        // spawn once the condition clears.
        //
        // Nothing is lost by dropping it: a 4s retry cannot reach a daemon that needs longer
        // than 4s to answer, which is the whole wedge population, while this one ask waits ~12s.
        // The only case a retry caught and this does not is a daemon that recovers within a few
        // seconds of being asked — and DegradedDaemonFreshSpawnRouter.recover() already restores
        // it to full daemon service on the next spawn, off the startup clock entirely.
        // Do not delete this because 'unknown' and 'occupied' both hold — twice reviewed, twice
        // proposed for removal, and it regresses both times. The occupied branch below has no
        // endpointIsProvenDead check and the unknown hold does, so this read is the only thing
        // standing between a kill and a daemon whose socket entry vanished (a tmp reaper, a
        // failed publish) while it still hosts live agents: without it that reads as
        // unknown + proven-dead and falls through to killStaleDaemon.
        //
        // The children scan earns its keep for the same reason in reverse: a verified-live pid
        // alone would also hold a *childless* daemon whose socket vanished, which is the one
        // #8689 case we can still safely replace.
        //
        // The evidence that separates a wedged daemon still hosting terminals from one with
        // nothing left to lose (#8689). Read once IPC has had its full chance, and only when
        // it never answered — both because it costs a process scan, and because identity has
        // to be re-verified first: the grace window is long enough for the daemon to die and
        // its pid to be recycled, and the evidence would then describe a stranger's children.
        const evidencePid =
          occupancy.state === 'unknown' &&
          process.platform !== 'win32' &&
          classificationRemainingMs() >= CLASSIFICATION_EVIDENCE_MIN_MS
            ? ((await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath))?.pid ?? null)
            : null
        occupancy = await raiseOccupancyWithProcessEvidence(occupancy, evidencePid)
        if (occupancy.state === 'occupied') {
          const owned =
            occupancy.liveSessions === null
              ? 'live terminal processes'
              : `${occupancy.liveSessions} live session${occupancy.liveSessions === 1 ? '' : 's'}`

          // Why this comes first: adoption opens a hello, and neither of these daemons can
          // complete one — 'rejected' answered and refused, and a count only the process table
          // could supply means nothing answered across the whole grace window. `health` is a
          // reading from before that window, so it cannot overrule them. Attempting adoption
          // anyway throws, and the throw costs the app its daemon entirely.
          if (health === 'rejected' || occupancy.liveSessions === null) {
            console.warn(
              `[daemon] DEGRADED MODE: holding a daemon that cannot be adopted (health=${health}) but still owns ${owned}. Killing it would end them; fresh terminals run on the local provider WITHOUT daemon persistence until it recovers or you restart it (Manage Sessions → Restart).`
            )
            return holdIncumbentDaemon()
          }
          if (health === 'pty-spawn-unhealthy') {
            // It answered listSessions just now, so it is adoptable — it simply cannot open
            // new PTYs.
            console.warn(
              `[daemon] DEGRADED MODE: preserving daemon that failed the PTY spawn health check because it owns ${owned}. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).`
            )
            return preserveDaemon('degraded-new-pty-fallback')
          }
          console.warn(
            `[daemon] Preserving daemon that failed the health check because it owns ${owned}`
          )
          return preserveDaemon()
        }
        // 'unknown' is not permission to kill. Everything above has failed to establish what
        // this daemon is hosting, and killing it on that basis is what destroyed live agents.
        // Bounded classification cannot be made safe by budgeting — matching main's tolerance
        // for one ask costs more clock than the 60s fail-open leaves — so the residual stops
        // being lethal instead. Being wrong now costs a degraded session, not an agent.
        //
        // Two exclusions, both about not holding something that can never be recovered:
        //   - a proven-dead endpoint is a cold start or a corpse; there is nothing to hold, and
        //     holding would hand every first launch a provider pointed at no daemon. Read fresh
        //     here rather than reused, because the daemon can die during the grace window.
        //   - 'rejected' answered and refused the handshake, so it can never be adopted and its
        //     sessions can never be reattached. Holding one is permanently degraded for nothing.
        if (
          occupancy.state === 'unknown' &&
          health !== 'rejected' &&
          !endpointIsProvenDead(await probeSocketConnect(socketPath))
        ) {
          console.warn(
            `[daemon] DEGRADED MODE: holding an unreachable daemon (health=${health}); its session state could not be verified, and replacing it would end any terminals it still owns. Fresh terminals run on the local provider WITHOUT daemon persistence until it recovers or you restart it (Manage Sessions → Restart). If a restart does not clear this, something other than an Orca daemon is holding the endpoint — quit and relaunch.`
          )
          return holdIncumbentDaemon()
        }
        // Why: a cold start reaches this same fall-through with nothing to replace, so stay
        // quiet unless something actually answered — a verified count, a socket that survived
        // a grace retry, or a refused hello.
        // Why: telemetry gates on confirmedReplacement below — the post-kill truth — so a
        // cold start that killed nothing never reports a replacement.
        pendingReplacement = {
          reason: 'failed_health_check',
          liveSessionCount: occupancy.liveSessions,
          verdict: `health=${health}, occupancy=${occupancy.state}`,
          announce: occupancy.state === 'empty' || health === 'rejected'
        }
      }

      // Why: a raw socket can outlive a broken daemon; kill by PID before respawn so the new daemon doesn't race the stale one.
      adoptionClient?.disconnect()
      adoptionClient = null
      const killOutcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath)
      if (killOutcome.liveOwnerSurvived) {
        // Why: forking beside a daemon we could not prove dead is precisely how the endpoint
        // owner and the session host diverge. But refusing outright would leave the user with
        // no daemon at all, and we have just proved something still answers the endpoint —
        // so adopt it in degraded mode: existing sessions keep working, new PTYs run locally.
        console.warn(
          '[daemon] DEGRADED MODE: adopting a daemon that could not be confirmed stopped. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          // Why: adoption needs a hello, which is exactly what a daemon wedged enough to be
          // preserved cannot answer. A still-listening endpoint means it is wedged, not gone,
          // so keep a lease-free handle: the lease only cancels the adoption watchdog, which
          // cannot fire on a daemon that still owns sessions, and throwing here would cost the
          // app its daemon handle — taking Manage Sessions → Restart down with it.
          if (!endpointIsProvenDead(await probeSocketConnect(socketPath))) {
            return createPreservedDaemonHandle(runtimeDir, PROTOCOL_VERSION, 'held')
          }
          // It died between the probe and the adoption; the endpoint is genuinely free now.
          throw new DaemonEndpointOwnershipError(
            'Daemon replacement aborted: the existing daemon could not be confirmed stopped'
          )
        }
      }
      if (pendingReplacement?.verdict && (pendingReplacement.announce || killOutcome.killed)) {
        console.warn(
          `[daemon] Replacing daemon that failed the health check (${pendingReplacement.verdict})`
        )
      }
      confirmedReplacement = killOutcome.killed || confirmedReplacement
      // Why: rank by how well each reason is evidenced. A confirmed kill whose reason positively
      // identified the daemon outranks the attribution, so a stale bundle caught here is not billed
      // to the resolver. failed_health_check is the residual "couldn't tell" bucket though — it also
      // absorbs wedges and crashes — so the adapter's attribution beats it. That case is not exotic:
      // the same dead login session that fails the resolver also fails the PTY spawn probe, and with
      // zero live sessions that lands here rather than in the degraded preserve above.
      const identifiedReplacement =
        pendingReplacement &&
        confirmedReplacement &&
        pendingReplacement.reason !== 'failed_health_check'
          ? pendingReplacement
          : null
      if (identifiedReplacement) {
        trackDaemonReplaced(identifiedReplacement.reason, identifiedReplacement.liveSessionCount)
      } else if (attributedReason) {
        trackDaemonReplaced(attributedReason, 0)
      } else if (pendingReplacement && confirmedReplacement) {
        trackDaemonReplaced(pendingReplacement.reason, pendingReplacement.liveSessionCount)
      }

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
          '--entry-path',
          entryPath,
          '--app-version',
          app.getVersion(),
          '--spawner-exec-path',
          process.execPath,
          ...(macosLoginSessionWatch ? ['--login-session-watch'] : []),
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
      let launchedIdentity: DaemonEndpointIdentity | null = null
      let endpointUnavailableReason: string | null = null
      const startupSignal = new Promise<void>((resolve, reject) => {
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
          if (Number.isSafeInteger(child.pid) && (child.pid as number) > 0) {
            unlinkOwnedDaemonPidFile(pidPath, child.pid as number, launchNonce)
          }
          reject(startupError)
        }
        function onReadyMessage(msg: unknown): void {
          if (
            msg &&
            typeof msg === 'object' &&
            (msg as { type?: string }).type === 'endpoint-unavailable'
          ) {
            // Why: the child lost the endpoint race rather than crashing. Record it so the
            // launcher can adopt the winner instead of reporting a generic startup failure.
            endpointUnavailableReason = (msg as { reason?: string }).reason ?? 'occupied'
            void fail(new Error(`Daemon could not take the endpoint: ${endpointUnavailableReason}`))
            return
          }
          if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
            if (settled) {
              return
            }
            const readyIdentity = parseDaemonReadyIdentity(msg)
            if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0 || !readyIdentity) {
              void fail(new Error('Daemon readiness identity is incomplete'))
              return
            }
            launchedIdentity = {
              pid: child.pid as number,
              ...readyIdentity,
              launchNonce
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
          if (code === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
            // Why here and not only on the IPC message: the exit is the event this wait settles
            // on, so keying off it cannot lose to a notification still in the channel.
            endpointUnavailableReason = 'occupied'
          }
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
        await startupSignal
      } catch (error) {
        if (endpointUnavailableReason !== 'occupied') {
          throw error
        }
        // Why adopt rather than retry: another daemon proved it owns the endpoint and is
        // answering on it. Forking again would lose the same race, and reporting a startup
        // failure strands this app on local non-persistent PTYs beside a healthy daemon.
        console.warn(
          '[daemon] Endpoint was taken by another daemon during startup — adopting it instead'
        )
        // Why pidPath: adopting reconciles the PID record against the identity the daemon
        // reports over hello, repairing a record that names the wrong incarnation. Every other
        // adoption path passes it; this one skipped it, so the incumbent we adopt here was the
        // only one whose record never got that repair.
        return await holdDaemonAdoptionLease(
          createPreservedDaemonHandle(runtimeDir),
          socketPath,
          tokenPath,
          undefined,
          undefined,
          pidPath
        )
      }

      try {
        if (!launchedIdentity) {
          throw new Error('Daemon readiness identity is incomplete')
        }
        return await holdDaemonAdoptionLease(
          {
            shutdown: () => terminateLaunchedDaemonChild(child)
          },
          socketPath,
          tokenPath,
          undefined,
          launchedIdentity,
          pidPath
        )
      } catch (error) {
        if (error instanceof DaemonEndpointOwnershipError) {
          await terminateLaunchedDaemonChild(child)
          unlinkOwnedDaemonPidFile(pidPath, child.pid as number, launchNonce)
          throw error
        }
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
      adoptionClient = null
      // Why: the launcher may now fork onto an endpoint it could not classify, because the
      // publisher is the real guard — and that guard works by refusing to overwrite what it
      // cannot prove dead, so the child exits instead of splitting the brain. Correct, but
      // giving up here costs the user every persistent session for the whole run. Something
      // answering the endpoint now is a daemon worth adopting, not a reason to fall back to
      // local PTYs.
      if (await probeSocket(socketPath)) {
        console.warn(
          '[daemon] DEGRADED MODE: adopting the daemon that owns the endpoint after a replacement could not publish onto it. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          // Why not hold here, unlike the failed-health path: that one declined to kill
          // because it had proof of live work. This one arrives with occupancy unknown or
          // empty, so holding would swallow a real launch failure to protect nothing.
          // It stopped answering between the probe and the adoption; report the launch failure.
        }
      }
      throw error
    }
  }
}

export async function initDaemonPtyProvider(
  signal?: AbortSignal,
  options: { macosLoginSessionWatch?: boolean } = {}
): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Why: e2e coverage for the startup PTY gate (#5232) needs a daemon init that deterministically outlasts the first-window timeout.
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir, options.macosLoginSessionWatch ?? false)
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
      tokenPath: info.tokenPath,
      pidPath: getDaemonPidPath(runtimeDir),
      profileScope: runtimeDir
    })
    releaseDaemonAdoptionLease(newSpawner.getHandle())
    await abortedStartupAdapter.disconnectOnly()
    return
  }

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    historyPath: getHistoryDir(),
    // Why: on daemon death, ensureConnected() detects the dead socket and calls this to fork a replacement before retrying.
    respawn: async (reason: DaemonRespawnReason) => {
      // Why: attribute rather than emit — the launcher below is the one that completes the
      // replacement, and emitting here would fire before the outcome is known.
      // Caveat: a wedged-but-alive daemon (#8689) can still report died_respawn here and
      // failed_health_check from the launcher — the app cannot tell wedged from dead at this point.
      if (reason === 'daemon_died') {
        console.warn('[daemon] Daemon process died — respawning')
        // Why: a manual restart tears the daemon down under a still-live adapter, so a pane
        // respawning on its synthetic exit would bill a user action to the crash bucket.
        if (!restartInFlight) {
          trackDaemonRetired('died_respawn')
        }
      } else if (reason === 'unhealthy_resolver') {
        // Must reach the launcher below without an await in between; see the consume site.
        attributedReplaceReason = 'unhealthy_resolver'
      }
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(newSpawner.getHandle())
    }
  })
  let legacyAdapters: DaemonPtyAdapter[] = []
  let routedAdapter: DaemonProvider = newAdapter
  try {
    // Why: the launcher's temporary pair closes only after this permanent pair is established, leaving no adoption gap.
    // Why skipped when held: we deliberately never talked to that daemon, so there is no
    // handshake to complete and no temporary lease to hand over. Attempting one would throw
    // and abort init, leaving the app with no spawner — and restartDaemon() throws without one.
    if (launchMode !== 'held') {
      await newAdapter.establishLifecycleLease()
      releaseDaemonAdoptionLease(newSpawner.getHandle())
    }

    legacyAdapters = await createLegacyDaemonAdapters(runtimeDir)
    routedAdapter =
      launchMode === 'degraded-new-pty-fallback' || launchMode === 'held'
        ? new DegradedDaemonPtyProvider({
            current: newAdapter,
            legacy: legacyAdapters,
            fallback: getLocalPtyProvider(),
            probeCurrentDaemonSpawn: async () =>
              (await checkDaemonHealth(info.socketPath, info.tokenPath)) === 'healthy'
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
  logDaemonMilestone('daemon-init-done', {
    legacyAdapters: legacyAdapters.length
  })
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

// Why: computed from the pid record on demand (not cached at adoption) so the Settings
// remedy surface always reflects the daemon actually serving terminals right now.
export async function getCurrentDaemonMacTccAttributionHealth(): Promise<MacDaemonTccAttributionHealth> {
  const runtimeDir = getRuntimeDir()
  return getMacDaemonTccAttributionHealth(
    runtimeDir,
    getDaemonSocketPath(runtimeDir),
    getDaemonTokenPath(runtimeDir),
    app.isPackaged ? app.getVersion() : null
  )
}

/** Returns null unless every daemon generation supplied an authoritative inventory. */
export async function listLiveDaemonPtyIds(): Promise<string[] | null> {
  if (!adapter) {
    return null
  }
  const adapters =
    adapter instanceof DaemonPtyRouter || adapter instanceof DegradedDaemonPtyProvider
      ? adapter.getAllAdapters()
      : [adapter]
  const inventories = await Promise.allSettled(
    adapters.map((daemonAdapter) => daemonAdapter.listProcesses())
  )
  if (inventories.some((inventory) => inventory.status === 'rejected')) {
    return null
  }
  return inventories.flatMap((inventory) =>
    inventory.status === 'fulfilled' ? inventory.value.map((process) => process.id) : []
  )
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
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    historyPath: getHistoryDir(),
    respawn: async (reason: DaemonRespawnReason) => {
      // Why: attribute rather than emit — the launcher below is the one that completes the
      // replacement, and emitting here would fire before the outcome is known.
      // Caveat: a wedged-but-alive daemon (#8689) can still report died_respawn here and
      // failed_health_check from the launcher — the app cannot tell wedged from dead at this point.
      if (reason === 'daemon_died') {
        console.warn('[daemon] Daemon process died — respawning')
        // Why: a manual restart tears the daemon down under a still-live adapter, so a pane
        // respawning on its synthetic exit would bill a user action to the crash bucket.
        if (!restartInFlight) {
          trackDaemonRetired('died_respawn')
        }
      } else if (reason === 'unhealthy_resolver') {
        // Must reach the launcher below without an await in between; see the consume site.
        attributedReplaceReason = 'unhealthy_resolver'
      }
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
    const killOutcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
    didKillStaleDaemon = killOutcome.killed
    if (killOutcome.liveOwnerSurvived) {
      // Why: something still owns the endpoint. Returning as if it were cleaned lets restart
      // fork a replacement that cannot publish onto the held name, leaving the user with no
      // daemon instead of the one still running.
      throw new DaemonEndpointOwnershipError(
        'Daemon cleanup aborted: the existing daemon could not be confirmed stopped'
      )
    }
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

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
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
      }
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
