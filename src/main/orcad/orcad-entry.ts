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
import { join } from 'node:path'
import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'
import { prepareOrcadCliLauncher } from './orcad-cli-launcher'
import {
  installOrcadHostAdapters,
  prepareOrcadSecretStore,
  runOrcadQuitHandlers
} from './orcad-host-adapters'
import { describeOrcadBindExposure, resolveOrcadBindHost } from './orcad-bind-address'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  startOrcadWithHost,
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
import {
  changedAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { adoptWslHostLoginEnvironment } from './orcad-wsl-host-login-environment'
import { installOrcadProcessErrorGuards } from './orcad-process-error-guards'
import { orcadWsPortOptions } from './orcad-ws-port-policy'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'

export { parseArgs }

let closeOrcadObservability = (): void => {}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  // Why: an orcad started from an Orca terminal must not fence its own CLI children to that Orca.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Why, as on the desktop: an inherited value would aim the CLI-shared Codex home paths elsewhere.
  process.env.ORCA_USER_DATA_PATH = userDataPath
  const { readiness, instance, stop } = await startOrcadWithHost(
    userDataPath,
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

async function prepareOrcadSecretStoreAndMigrate(userDataPath: string): Promise<void> {
  const { getSecretStore } = await import('../../shared/secret-store')
  const { reportSecretProtectionGap } = await import('../host/secret-protection-report')
  const { migratePlaintextCredentials, orcadCredentialRoot } =
    await import('./orcad-plaintext-credential-migration')
  // Why the credential root, not userData: a disposable ORCA_USER_DATA would take the key with it.
  if (await prepareOrcadSecretStore(orcadCredentialRoot(), userDataPath)) {
    migratePlaintextCredentials(getSecretStore())
  }
  reportSecretProtectionGap({ dataFile: join(userDataPath, 'orca-data.json') })
}

async function startOrcadRuntime(
  options: OrcadOptions,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): Promise<Pick<OrcadHandle, 'readiness'>> {
  // Started first so the login-shell probe overlaps the imports and store startup below.
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
  // Why importable here: the singleton's module tree never reaches Electron, and orcad supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { agentHookRuntimeDeps } = await import('../agent-hooks/agent-hook-runtime-deps')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { startOrcadManagedAgentHooks } = await import('./orcad-managed-agent-hooks')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } = await import('../ipc/parcel-watcher-process')

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
  // Why disconnect and not shut down: the daemon must outlive this process, or an orcad
  // restart goes back to killing every running terminal.
  registerCleanup(() => stopOrcadDaemon())
  registerCleanup(async () => {
    // A SQLite-backed orcad has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      // Layout-owner build: a pane's grid still inside its write burst joins the final save.
      const paneGrids = paneGridsForShutdown?.flushPaneGrids()
      if (paneGrids) {
        await paneGrids
      }
      await flushOrcadProfileStoreForShutdown(profileStoreForShutdown)
    }
  })
  // Watcher children outlive a disposal that does not wait for them.
  registerCleanup(() => disposeWatcherProcessAndWait())
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { startEventLoopDelayProbe } = await import('../diagnostics/event-loop-delay-probe')
  startEventLoopDelayProbe('orcad', runtimeUserDataPath)
  // A missing `orca` command must never keep the server from starting.
  await prepareOrcadCliLauncher().catch((error: unknown) => {
    console.warn('[orcad] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginOrcadIdleExit(runtimeUserDataPath)
  // Why before the profile store: it unseals protected settings as it loads.
  await prepareOrcadSecretStoreAndMigrate(runtimeUserDataPath)
  const { store: profileStore, authority: profileStateAuthority } =
    await createOrcadProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  // Before the hook server starts: a turn that begins before the feed subscribes is never counted.
  const { startOrcadStats } = await import('./orcad-stats')
  const stats = startOrcadStats(runtimeUserDataPath, agentHookServer, registerCleanup)
  await agentHookServer.start({
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  // Before hook reconcile, the daemon and the runtime: each reads or inherits this env.
  await loginEnvironment
  startOrcadManagedAgentHooks(
    profileStore,
    (enabled) => agentHookServer.setStatusHooksEnabled(enabled),
    registerCleanup
  )

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startOrcadDaemon()

  // Why a holder and not a direct reference: the index is installed after the runtime is
  // constructed, and the deps hook is only ever called later, from an RPC.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const { orcadCodexAccountHomes } = await import('./orcad-codex-account-homes')
  const codexAccountHomes = orcadCodexAccountHomes(
    () => profileStore.getSettings(),
    registerCleanup
  )

  // Why before the runtime: its structured Codex resolvers are constructor deps.
  const { createOrcadAccountServices } = await import('./orcad-account-services')
  const accountLaunch = createOrcadAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })

  const { loadAgentSessionClaimSigner } = await import('../runtime/agent-session-claim-identity')
  const runtime = new OrcaRuntimeService(profileStore, stats, {
    // Why persistent: the terminal daemon outlives orcad, so a per-process key would make a
    // restarted orcad unable to recognise (and adopt) the agent PTYs it already owns.
    agentSessionClaimSigner: loadAgentSessionClaimSigner(runtimeUserDataPath, runtimeUserDataPath),
    getAdditionalAiVaultCodexHomePaths: () => [
      ...codexAccountHomes.listSessionHomes(),
      ...(accountLaunch?.listCodexSessionHomes() ?? [])
    ],
    // Why absent on a WSL host: a resolver overrides the desktop-pushed CODEX_HOME.
    ...accountLaunch?.runtimeDeps,
    // Why here too: orcad serves `worktree.ps` and `agentSession.*`; unwired it lists no agents.
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      profileStore.getSettings()
    ),
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why the daemon predicate and not a constant: orcad now spawns the terminal daemon, so
    // its PTYs DO survive an orcad restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why the dedupe here and not in the instance: `apply` closes and reconstructs
    // unconditionally, so an unchanged value would restart a healthy index.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })
  paneGridsForShutdown = runtime

  accountLaunch?.attachToRuntime(runtime)

  // Why before any launch: a desktop that owns this host's accounts pushed them on an earlier run.
  const { restoreOrcadHostAccountLaunchEnv } = await import('./orcad-host-account-launch-env-store')
  restoreOrcadHostAccountLaunchEnv(runtime, runtimeUserDataPath)

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
  // Switch point: main's load repair, here too, now that this runtime can move pane owners.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const { repairDuplicatePtyPanesOnStart } = await import('../runtime/moved-pane-owner-rekey')
    // Awaited: it queues behind any in-flight write, and must land before reconcile and RPC.
    await repairDuplicatePtyPanesOnStart(profileStore, runtime)
  }

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and orcad's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )
  registerCleanup(runtime.attachAgentStatusStore(agentHookServer))

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // A client-sent Codex account home wins; otherwise this host's own selection applies. A WSL host
  // has none: its desktop sends the prepared account env.
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

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()
  // Switch point: main shows live terminals no pane shows, before any client attaches.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  // Hook rows hydrated and the PTY runtime registered: stored sort tiers can be checked.
  runtime.agentTransitions.seedRestoredRows()
  void runtime.sidebarFacts?.reconcileSortStampTiers(getLocalPtyProvider())

  // Runs after RPC stops (cleanups run reversed); later records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // A retry armed during recovery would otherwise write after the final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  // Why before the RPC server binds: like `--serve`, the first client must find a ready graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Store load skipped moved shell history: only the runtime can tell which worktrees run a shell.
  void runtime.installPendingOrcadMigrationShellHistory().catch((error: unknown) => {
    console.error('[orcad-migration] installing pending shell history failed:', error)
  })

  const bindHost = resolveOrcadBindHost(options.bind)
  bindOrcadStopTerminalAdmission(runtime.terminalUpdateAdmission)
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    webClientRoot: resolveOrcadWebClientRoot(options.webClientRoot),
    ...orcadWsPortOptions(options.port)
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
  let shutdownTrigger: OrcadShutdownTrigger | null = null
  // Before startup: its fire-and-forget chains can reject before the first await settles.
  installOrcadProcessErrorGuards(() => shutdownTrigger)
  const startup = startOrcad(options)
  const requestShutdown = installOrcadShutdownSignals(async () => (await startup).stop())
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Why after startup: a managed request must name the runtime and instance this run became.
  installOrcadStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveOrcadInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareOrcadManagedStop
  })
  bindOrcadIdleShutdown(requestShutdown)
}
