// Compose the Node-host runtime; paired desktop pages work even without a local browser engine.
import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'
import { prepareOrcadCliLauncher } from './orcad-cli-launcher'
import { installOrcadHostAdapters, runOrcadQuitHandlers } from './orcad-host-adapters'
import { prepareOrcadSecretStoreAndMigrate } from './orcad-secret-store-startup'
import { describeOrcadBindExposure, resolveOrcadBindHost } from './orcad-bind-address'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  startOrcadWithHost,
  stopOrcadStructuredAgentSessions,
  type OrcadShutdownTrigger
} from './orcad-lifecycle'
import { ORCAD_USAGE, parseArgs, resolveOrcadWebClientRoot } from './orcad-command-arguments'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import { installOrcadStopRequestListeners } from './orcad-stop-request-listener'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import { bindOrcadStopTerminalAdmission } from './orcad-stop-terminal-admission'
import type { OrcadHandle, OrcadOptions } from './orcad-start-contract'
import { beginOrcadIdleExit, bindOrcadIdleShutdown } from './orcad-managed-idle-exit-host'
import { orcadAutomationsKeepHostBusy, startOrcadAutomations } from './orcad-automations'
import { changedAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { adoptWslHostLoginEnvironment } from './orcad-wsl-host-login-environment'
import { installOrcadProcessErrorGuards } from './orcad-process-error-guards'
import { orcadWsPortOptions } from './orcad-ws-port-policy'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'

export { parseArgs }

let closeOrcadObservability = (): void => {}

/** Resolve after transport readiness publishes the desktop-compatible serve payload. */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  // Inherited terminal identity must not fence orcad’s CLI children to the launching desktop.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Override inherited data roots so CLI-shared Codex homes resolve on this host.
  process.env.ORCA_USER_DATA_PATH = userDataPath
  const { readiness, instance, stop } = await startOrcadWithHost(
    userDataPath,
    (registerCleanup) => startOrcadRuntime(options, registerCleanup),
    () => {
      try {
        runOrcadQuitHandlers()
      } finally {
        // Close after quit handlers, including failed ones, so their spans reach disk.
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
  // Overlap login-shell probing with imports and store startup.
  const loginEnvironment = adoptWslHostLoginEnvironment().then(
    (names) => {
      if (names.length > 0) {
        console.info(`[orcad] adopted login-shell variables: ${names.join(', ')}`)
      }
    },
    (error: unknown) => console.warn('[orcad] could not adopt login-shell variables:', error)
  )
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime } = await import('../ipc/pty/register-headless-runtime')
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { installOrcadObservability } = await import('./orcad-observability')
  closeOrcadObservability = installOrcadObservability()
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { servePublishMode } = await import('../server/serve-pairing-readiness')
  const { buildOrcadServeReadiness } = await import('./orcad-serve-readiness')
  const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')
  const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-provider-state')
  const { collectOrcadHealth } = await import('./orcad-health')
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { agentHookRuntimeDeps } = await import('../agent-hooks/agent-hook-runtime-deps')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { startOrcadManagedAgentHooks } = await import('./orcad-managed-agent-hooks')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } =
    await import('../ipc/filesystem/watcher-process/parcel-watcher-process')

  let paneGridsForShutdown: { flushPaneGrids(): Promise<void> | null } | null = null
  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  // Cleanups run in reverse: RPC, then recovery and watchers, then the final flush, then daemon.
  registerCleanup(() => agentHookServer.stop())
  registerCleanup(() => uninstallHookStatusRepublish())
  registerCleanup(() => uninstallObservedStatusIdentity())
  // Disconnect without killing daemon PTYs that must survive restart.
  registerCleanup(() => stopOrcadDaemon())
  registerCleanup(async () => {
    // A SQLite-backed orcad has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      await flushOrcadProfileStoreForShutdown(profileStoreForShutdown, paneGridsForShutdown)
    }
  })
  registerCleanup(stopOrcadStructuredAgentSessions)
  registerCleanup(() => disposeWatcherProcessAndWait())
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { startEventLoopDelayProbe } = await import('../diagnostics/event-loop-delay-probe')
  startEventLoopDelayProbe('orcad', runtimeUserDataPath)
  await prepareOrcadCliLauncher().catch((error: unknown) => {
    console.warn('[orcad] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginOrcadIdleExit(runtimeUserDataPath)
  const { orcadSessionScannerIdleTimeoutMs } = await import('./orcad-session-scanner-idle')
  const scannerIdleTimeoutMs = orcadSessionScannerIdleTimeoutMs()
  if (scannerIdleTimeoutMs !== null) {
    const { setAiVaultServiceIdleTimeoutMs } =
      await import('../ai-vault/session-scanner-service-spawn')
    setAiVaultServiceIdleTimeoutMs(scannerIdleTimeoutMs)
  }
  // Initialize sealing before Store load unseals protected settings.
  await prepareOrcadSecretStoreAndMigrate(runtimeUserDataPath)
  const { store: profileStore, authority: profileStateAuthority } =
    await createOrcadProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  // Subscribe before hooks start so early turns are counted.
  const { startOrcadStats } = await import('./orcad-stats')
  const stats = startOrcadStats(runtimeUserDataPath, agentHookServer, registerCleanup)
  await agentHookServer.start({
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  // Reconcile, daemon and runtime all consume this environment.
  await loginEnvironment
  startOrcadManagedAgentHooks(
    profileStore,
    (enabled) => agentHookServer.setStatusHooksEnabled(enabled),
    registerCleanup
  )

  // Install the daemon provider before PTY handlers can route their first call.
  await startOrcadDaemon()

  // Runtime constructor callbacks use this index only after it is installed.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const { orcadCodexAccountHomes } = await import('./orcad-codex-account-homes')
  const codexAccountHomes = orcadCodexAccountHomes(
    () => profileStore.getSettings(),
    registerCleanup
  )

  const { createOrcadAccountServices } = await import('./orcad-account-services')
  const accountLaunch = createOrcadAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })

  const { orcadAiVaultSessionSources, installOrcadSessionSearchService } =
    await import('./orcad-session-search')
  const { loadAgentSessionClaimSigner } =
    await import('../runtime/agent-session/ownership/agent-session-claim-identity')
  const runtime = new OrcaRuntimeService(profileStore, stats, {
    // Persistent signatures let restarted runtimes adopt PTYs owned before restart.
    agentSessionClaimSigner: loadAgentSessionClaimSigner(runtimeUserDataPath, runtimeUserDataPath),
    ...orcadAiVaultSessionSources(profileStore, codexAccountHomes, accountLaunch),
    // Why absent on a WSL host: a resolver overrides the desktop-pushed CODEX_HOME.
    ...accountLaunch?.runtimeDeps,
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      profileStore.getSettings()
    ),
    // Resolve lazily because daemon swaps replace the provider after construction.
    getLocalProvider: () => getLocalPtyProvider(),
    // Read current daemon ownership; failed/degraded launch cannot claim fresh PTY persistence.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Node hosts cannot promote into desktop windows; override the constructor’s openable default.
    getDesktopWindowStatus: () => 'blocked',
    // Unchanged settings would reconstruct a healthy search index; deduplicate before apply.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })
  paneGridsForShutdown = runtime

  accountLaunch?.attachToRuntime(runtime)
  const { installOrcadEmulatorBridge } = await import('./orcad-emulator-bridge')
  installOrcadEmulatorBridge(runtime, registerCleanup)

  // Restore prior desktop-pushed account selection before automations or CLI launches.
  const { restoreOrcadHostAccountLaunchEnv } = await import('./orcad-host-account-launch-env-store')
  restoreOrcadHostAccountLaunchEnv(runtime, runtimeUserDataPath)

  sessionSearch = await installOrcadSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  const { startAgentStateRulesLiveUpdates } =
    await import('../runtime/agent-state-rules/agent-state-rules-live-update')
  startAgentStateRulesLiveUpdates(profileStore, (rules) =>
    console.info(`[orcad] agent state rules ${rules.version} (${rules.source})`)
  )
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const { repairDuplicatePtyPanesOnStart } = await import('../runtime/moved-pane-owner-rekey')
    // Wait behind earlier writes and persist repair before reconciliation/RPC admission.
    await repairDuplicatePtyPanesOnStart(profileStore, runtime)
  }

  // Status changes must republish session.tabs to paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )
  registerCleanup(runtime.attachAgentStatusStore(agentHookServer))

  // Headless registration threads Store into persistence; account homes prefer client then host selection.
  // WSL has no host selection and keeps the desktop-prepared environment.
  await registerHeadlessPtyRuntime(
    runtime,
    async (target, launchEnv, context) =>
      (await codexAccountHomes.selectLaunchHome(target, launchEnv, context)) ??
      (accountLaunch ? accountLaunch.prepareCodexHome(target, launchEnv, context) : null),
    () => profileStore.getSettings(),
    accountLaunch?.prepareClaudeAuth,
    profileStore,
    accountLaunch?.prepareCodexSessionResume
  )

  // Recover browser/orchestration authority before clients attach to the runtime graph.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  runtime.agentTransitions.seedRestoredRows()
  void runtime.sidebarFacts?.reconcileSortStampTiers(getLocalPtyProvider())

  // Run after RPC stops; later dismissal records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // Stop recovery retries before final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery establishes terminal/dispatch identities before fencing observations.
  observedStatusCapture.attach(runtime)
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  // First RPC clients must see a fully published graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Only the runtime can identify running shells and install deferred migrated history.
  void runtime.installPendingOrcadMigrationShellHistory().catch((error: unknown) => {
    console.error('[orcad-migration] installing pending shell history failed:', error)
  })

  const bindHost = resolveOrcadBindHost(options.bind)
  bindOrcadStopTerminalAdmission(runtime.terminalUpdateAdmission)
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Pin operator exposure across restarts; pairing must not silently widen a loopback bind.
    pinnedBindHost: bindHost,
    webClientRoot: resolveOrcadWebClientRoot(options.webClientRoot),
    ...orcadWsPortOptions(options.port)
  })
  // Stop RPC before cleanup can tear down writers and runtime state.
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
    emulatorsBusy: async () =>
      (await runtime.getEmulatorBridge()?.hasLiveManagedSessions()) ?? false,
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
  let shutdownTrigger: OrcadShutdownTrigger | null = null
  // Fire-and-forget startup work can reject before its first await completes.
  installOrcadProcessErrorGuards(() => shutdownTrigger)
  const startup = startOrcad(options)
  const requestShutdown = installOrcadShutdownSignals(async () => (await startup).stop())
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Stop requests must name the runtime/instance established by startup.
  installOrcadStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveOrcadInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareOrcadManagedStop
  })
  bindOrcadIdleShutdown(requestShutdown)
}
