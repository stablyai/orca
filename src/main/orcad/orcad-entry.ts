/**
 * `orcad` — the Orca runtime served without Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications or renderer delivery.
 * Browser automation is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import {
  getAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServeReadiness } from '../server/serve-readiness'
import { resolveOrcadInstallRoot, resolveOrcadPath, resolveUserDataPath } from './orcad-app-paths'
import { getOrcadCliLauncherPath, prepareOrcadCliLauncher } from './orcad-cli-launcher'
import { describeOrcadBindExposure, resolveOrcadBindHost } from './orcad-bind-address'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  startOrcadWithHost
} from './orcad-lifecycle'
import { ORCAD_USAGE, parseArgs } from './orcad-command-arguments'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import { installOrcadStopRequestListeners } from './orcad-stop-request-listener'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import type { OrcadManagedStopContext } from '../../shared/orcad-stop-request'
import { beginOrcadIdleExit, bindOrcadIdleShutdown } from './orcad-managed-idle-exit-host'
import { orcadAutomationsKeepHostBusy, startOrcadAutomations } from './orcad-automations'
import {
  changedAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'

export { parseArgs }

let runOrcadQuitHandlers = (): void => {}
let closeOrcadObservability = (): void => {}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  runOrcadQuitHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'orcad_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    getCliLauncherPath: getOrcadCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    describeProtectionGap: () =>
      'This host has no OS keyring, so credentials are stored unencrypted. Pair from a desktop to manage secrets, or install and unlock a keyring.'
  }
}

export function installOrcadHostAdapters(): void {
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}

export type OrcadOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Desktop `orca serve` parity: a mobile-scoped offer with a terminal QR. */
  mobilePairing?: boolean
  /** Lets the paired runtime client drive this machine's desktop (computer.*). */
  grantDesktopControl?: boolean
  /** Desktop `orca serve` parity: print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  /** Literal IP to bind. Defaults to loopback; see orcad-bind-address.ts. */
  bind?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  /** What an instance-bound stop request must name to stop this process. */
  managedStop: OrcadManagedStopContext
  stop(): Promise<void>
}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  // Why: an orcad started from an Orca terminal must not fence its own CLI children to that Orca.
  stampRuntimeSourceEnv(process.env, null)
  const { readiness, instance, stop } = await startOrcadWithHost(
    resolveUserDataPath(),
    (registerCleanup) => startOrcadRuntime(options, registerCleanup),
    () => {
      try {
        runOrcadQuitHandlers()
      } finally {
        // Last, after every quit handler (even a failing one), so their spans still reach the file.
        closeOrcadObservability()
        closeOrcadObservability = () => {}
      }
    }
  )
  const version = getAppEnvironment().getVersion()
  return { readiness, managedStop: { version, runtimeId: readiness.runtimeId, instance }, stop }
}

async function startOrcadRuntime(
  options: OrcadOptions,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): Promise<Pick<OrcadHandle, 'readiness'>> {
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime, getLocalPtyProvider, getSshPtyProvider } =
    await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')
  const { installOrcadObservability } = await import('./orcad-observability')
  closeOrcadObservability = installOrcadObservability()
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { servePublishMode } = await import('../server/serve-pairing-readiness')
  const { buildOrcadServeReadiness } = await import('./orcad-serve-readiness')
  const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')
  const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-init')
  const { collectOrcadHealth } = await import('./orcad-health')
  // Why importable here: the singleton's module tree never reaches Electron, and orcad supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } = await import('../ipc/parcel-watcher-process')

  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  let removeStatusHookSettingsListener = (): void => {}
  // Cleanups run in reverse: RPC, then recovery and watchers, then the final flush, then daemon.
  registerCleanup(() => agentHookServer.stop())
  registerCleanup(() => uninstallHookStatusRepublish())
  registerCleanup(() => uninstallObservedStatusIdentity())
  registerCleanup(() => removeStatusHookSettingsListener())
  // Why disconnect and not shut down: the daemon must outlive this process, or an orcad
  // restart goes back to killing every running terminal.
  registerCleanup(() => stopOrcadDaemon())
  registerCleanup(async () => {
    // A SQLite-backed orcad has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      await flushOrcadProfileStoreForShutdown(profileStoreForShutdown)
    }
  })
  // Watcher children outlive a disposal that does not wait for them.
  registerCleanup(() => disposeWatcherProcessAndWait())
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  // A missing `orca` command must never keep the server from starting.
  await prepareOrcadCliLauncher().catch((error: unknown) => {
    console.warn('[orcad] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginOrcadIdleExit(runtimeUserDataPath)
  const { store: profileStore, authority: profileStateAuthority } =
    await createOrcadProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  await agentHookServer.start({
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  removeStatusHookSettingsListener = profileStore.onSettingsChanged((updates, settings) => {
    if ('agentStatusHooksEnabled' in updates) {
      agentHookServer.setStatusHooksEnabled(isAgentStatusHooksEnabled(settings))
    }
  })

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startOrcadDaemon()

  // Why a holder and not a direct reference: the index is installed after the runtime is
  // constructed, and the deps hook is only ever called later, from an RPC.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const runtime = new OrcaRuntimeService(profileStore, undefined, {
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: destructive worktree removal refuses to run without a provider to stop
    // processes through — correctly, since it cannot otherwise verify the tree is idle.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    // Why the daemon predicate and not a constant: orcad now spawns the terminal daemon, so
    // its PTYs DO survive an orcad restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why here too and not only on the desktop: main's OSC parse is the only producer for a
    // PTY agent on this host, and the store is the only place `worktree.ps` and the mobile
    // projection read from — unwired, orcad lists no PTY agents at all.
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    onClaudeTerminalEvidence: (paneKey, evidence) =>
      agentHookServer.observeClaudeTerminalEvidence(paneKey, evidence),
    // Why here too and not only on the desktop: orcad serves `worktree.ps` and `agentSession.*`,
    // so without these a headless host publishes its structured chats nowhere and lists no agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentStatusSnapshotForPane: (paneKey) => agentHookServer.getStatusSnapshotForPane(paneKey),
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    // Why captured rather than resolved at read: the fleet snapshot remints cached rows on every
    // read, so a row observed under one process otherwise acquires whatever process owns the pane now.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    structuredAgentStatusSink: {
      publish: (summary, subject) => agentHookServer.ingestStructuredStatus(summary, subject),
      forget: (subject) => agentHookServer.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        agentHookServer.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => agentHookServer.getStructuredChildWorkViews(subject)
    },
    checkHookAgentPresence: (paneKey) => agentHookServer.checkAgentPresence(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys),
    dropAgentStatusForRemovedWorktree: (worktreeId, host) =>
      agentHookServer.dropStatusEntriesForRemovedWorktree(worktreeId, host),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(profileStore.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    // Why the dedupe here and not in the instance: `apply` closes and reconstructs
    // unconditionally, so an unchanged value would restart a healthy index.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })

  const { installOrcadSessionSearchService } = await import('./orcad-session-search')
  sessionSearch = await installOrcadSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  // Why: this host evaluates its own panes, so it keeps its own rules current.
  const { startAgentStateRulesLiveUpdates } =
    await import('../runtime/agent-state-rules/agent-state-rules-live-update')
  startAgentStateRulesLiveUpdates(profileStore, (rules) =>
    console.info(`[orcad] agent state rules ${rules.version} (${rules.source})`)
  )

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and orcad's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // Codex-home and Claude-auth preparation are left unset: both are desktop account
  // flows. A launch that needs one fails with its own message rather than silently
  // spawning an unauthenticated agent.
  await registerHeadlessPtyRuntime(
    runtime,
    undefined,
    () => profileStore.getSettings(),
    undefined,
    profileStore
  )

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  // A retry armed during recovery would otherwise write after the final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)
  // Why before the RPC server binds: like `--serve`, the first client must find a ready graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)

  const bindHost = resolveOrcadBindHost(options.bind)
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  // Stops first: no RPC may write while the rest of the runtime is torn down.
  registerCleanup(() => rpc.stop())
  await rpc.start()
  startOrcadAutomations(runtime, profileStore, registerCleanup)
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
  console.error(`[orcad] ${describeOrcadBindExposure(bindHost)}`)

  const readiness = await buildOrcadServeReadiness({
    options,
    runtimeId: runtime.getRuntimeId(),
    rpc,
    collectHealth: () =>
      collectOrcadHealth(
        getAppEnvironment().getVersion(),
        profileStateAuthority,
        idleExitStartup.previousIdleStop
      )
  })

  await new ServeReadinessPublisher().publish(readiness, servePublishMode(options))

  await idleExitStartup.start({
    rpc,
    agentStates: () => agentHookServer.getStatusSnapshot(),
    hasStagedMigration: () => profileStore.hasStagedOrcadMigrationCatalog(),
    automationsBusy: () => orcadAutomationsKeepHostBusy(profileStore),
    registerCleanup
  })
  return { readiness }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(ORCAD_USAGE)
    return
  }
  const startup = startOrcad(options)
  const requestShutdown = installOrcadShutdownSignals(async () => (await startup).stop())
  const handle = await startup
  // Why after startup: a managed request must name the runtime and instance this run became.
  installOrcadStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveOrcadInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareOrcadManagedStop
  })
  bindOrcadIdleShutdown(requestShutdown)
}
