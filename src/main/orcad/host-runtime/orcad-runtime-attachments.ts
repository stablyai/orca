import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcadRelay } from '../orcad-relay'
import type { AiVaultSearchSettings } from '../../../shared/ai-vault/search/ai-vault-search-settings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import { installOrcadRelayAndAccount } from '../orcad-orca-account'

/** Wires store-backed runtime services that orcad owns once the runtime is constructed. */
export async function attachOrcadRuntimeServices(args: {
  runtime: OrcaRuntimeService
  store: Store
  registerCleanup: (cleanup: BackendServiceCleanup) => void
  attachAccounts: () => void
}): Promise<OrcadRelay> {
  const { runtime, store, registerCleanup } = args
  // Agent detection answers RPC before release reclaim, and must count Orca's copies then too.
  const { provideManagedAgentDetection } =
    await import('../../runtime/rpc/methods/host-management/managed-copy-detection')
  provideManagedAgentDetection()

  const { installFirstWorkRenameHookSubscription } =
    await import('../../agent-hooks/first-work/first-work-rename-hook-subscription')
  const { firstWorkRenameDeps } =
    await import('../../agent-hooks/first-work/first-work-rename-runtime')
  registerCleanup(installFirstWorkRenameHookSubscription(firstWorkRenameDeps(store, runtime)))
  const { installAgentTurnWorktreeActivity } =
    await import('../../agent-hooks/runtime/agent-turn-worktree-activity')
  registerCleanup(installAgentTurnWorktreeActivity())

  args.attachAccounts()
  const { wireGitHubIssueLinkTitleFill } =
    await import('../../github/workspace-links/github-issue-link-title-wiring')
  registerCleanup(wireGitHubIssueLinkTitleFill(store, runtime))
  // No renderer writes this host's PR cache; served reads fill it for worktree.ps and cleanup (#50758).
  const { installHostPRCache } =
    await import('../../github/pull-requests/refresh/host-pr-cache-backfill')
  installHostPRCache(store, runtime)
  const { installOrcadEmulatorBridge } = await import('./orcad-emulator-bridge')
  installOrcadEmulatorBridge(runtime, registerCleanup)
  const relay = await installOrcadRelayAndAccount(runtime, registerCleanup)
  const { BotShareClient } = await import('../../bots/sharing/bot-share-client')
  const { skillPackageDownloadOrigins } =
    await import('../../skills/runtime-transfer/skill-client-mediated-transfer')
  const appEnv = getAppEnvironment()
  const userDataPath = appEnv.getPath('userData')
  const isPackaged = appEnv.isPackaged()
  runtime.setBotShareClient(BotShareClient.forProfile(userDataPath), {
    temporaryRoot: join(userDataPath, 'bot-share-downloads'),
    allowedOrigins: skillPackageDownloadOrigins(!isPackaged),
    requireHttps: isPackaged
  })
  // Agents here set Google up through a paired desktop's browser; their key and secret stay here.
  const { installGoogleSetupHostWatch } = await import('../../google/google-setup-host-watch')
  registerCleanup(installGoogleSetupHostWatch(runtime))
  return relay
}

/** Starts session search plus the rule and speech services paired clients read through this host. */
export async function startOrcadHostSearchAndModels(
  store: Store,
  userDataPath: string
): Promise<{ apply(settings: AiVaultSearchSettings): void; dispose(): void } | null> {
  const { installOrcadSessionSearchService } = await import('./orcad-session-search')
  const { sessionSearchScopeCatalogFromStore } =
    await import('../../ai-vault-search/scope/session-search-store-scope-catalog')
  const sessionSearch = await installOrcadSessionSearchService({
    userDataPath,
    getSettings: () => store.getSettings(),
    // Workspace/Project scopes resolve through this host's own registrations, read per search.
    getScopeCatalog: () => sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID)
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  const { startAgentStateRulesLiveUpdates } =
    await import('../../runtime/agent-state-rules/agent-state-rules-live-update')
  startAgentStateRulesLiveUpdates(store, (rules) =>
    console.info(`[orcad] agent state rules ${rules.version} (${rules.source})`)
  )
  // Paired phones dictate through this host; keep its model loaded the same way the desktop does.
  const { startSpeechModelWarmup } = await import('../../speech/speech-model-warmup')
  startSpeechModelWarmup(store)
  return sessionSearch
}

export async function repairOrcadDuplicatePtyPanes(
  store: Store,
  runtime: OrcaRuntimeService
): Promise<void> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const { repairDuplicatePtyPanesOnStart } =
    await import('../../runtime/terminal/identity/moved-pane-owner-rekey')
  // Wait behind earlier writes and persist repair before reconciliation/RPC admission.
  await repairDuplicatePtyPanesOnStart(store, runtime)
}

/** First RPC clients must see a fully published graph. */
export async function publishOrcadRuntimeGraph(runtime: OrcaRuntimeService): Promise<void> {
  const { publishHeadlessRuntimeGraph } =
    await import('../../runtime/session-graph/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Only the runtime can identify running shells and install deferred migrated history.
  void runtime.installPendingOrcadMigrationShellHistory().catch((error: unknown) => {
    console.error('[orcad-migration] installing pending shell history failed:', error)
  })
}

export async function startOrcadManagedRuntimeReleases(runtime: OrcaRuntimeService): Promise<void> {
  const { reclaimManagedRuntimeReleasesAtLaunch, startManagedRuntimeAutoUpdates } =
    await import('../../runtime/rpc/methods/host-management/managed-runtime-install')
  reclaimManagedRuntimeReleasesAtLaunch(runtime)
  startManagedRuntimeAutoUpdates()
}

export function registerOrcadRuntimeShutdownSteps(
  runtime: OrcaRuntimeService,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
): void {
  // Run after RPC stops; later dismissal records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // Stop recovery retries before final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())
}
