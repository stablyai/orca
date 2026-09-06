// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithLinearCommands } from './orca-runtime-linear-commands'
import type { RuntimeStore } from './runtime-store-contract'
import type { StatsCollector } from '../stats/collector'
import type { IPtyProvider } from '../providers/types'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import type { AgentSessionClaimSigner } from './agent-session-claim-identity'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { installRuntimeFileCommandSurface } from './runtime-file-command-surface'
import { installRuntimeGitCommandSurface } from './runtime-git-command-surface'
import { installRuntimeRepositoryCommandSurface } from './runtime-repository-command-surface'
import { installRuntimeReviewCommandSurface } from './runtime-review-command-surface'
import { installRuntimeServiceCommandSurface } from './runtime-service-command-surface'
import {
  RuntimeSkillCommands,
  installRuntimeSkillCommandSurface
} from './runtime-skill-command-surface'
import { getAppEnvironment } from '../../shared/app-environment'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { RuntimeAutomationController } from './runtime-automation-controller'
import { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'
import { configureAiVaultSessionSources } from '../ai-vault/cached-session-list'
import { configureHostReadableTranscriptPathSources } from '../native-chat/host-readable-transcript-path'
import { createEphemeralAgentSessionClaimSigner } from './agent-session-claim-identity'
import { registerConptyDa1OverrideInstaller } from './terminal-model-query-authority'
import { registerTerminalViewAttributesApplier } from './terminal-view-attribute-store'

export class OrcaRuntimeWithStateFields extends OrcaRuntimeWithLinearCommands {
  constructor(
    store: RuntimeStore | null = null,
    stats?: StatsCollector,
    deps?: {
      getLocalProvider?: () => IPtyProvider
      getSshProvider?: (connectionId: string) => IPtyProvider | undefined
      onPtyStopped?: (ptyId: string) => void
      onTerminalAgentStatus?: (event: RuntimeTerminalAgentStatusEvent) => void
      onTerminalSideEffects?: (batch: TerminalSideEffectBatch) => void
      // Why: agent status mostly arrives via hooks (agent-hooks/server), not OSC
      // terminal output. worktree.ps reads this at query time so mobile shows the
      // same inline agent rows the desktop sidebar does — same source, 1:1.
      getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
      /** Same rows, but including the resume-identity-only ones `getAgentStatusSnapshot`
       *  filters out so they can't read as running agents. Mobile native chat needs
       *  them: for an agent that publishes identity separately (Pi), that row is the
       *  only carrier of the provider session a transcript is addressed by. */
      getAgentProviderSessionSnapshot?: () => AgentStatusIpcPayload[]
      getAgentProviderSessionRowsForPane?: (paneKey: string) => AgentStatusIpcPayload[]
      attestAgentHookCompatibilityAuthority?: (candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null
      retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
      reconcileAgentStatusForEndedProcess?: (paneKeys: Iterable<string>) => void
      canRecoverPersistentLocalPtys?: () => boolean
      // Why: the device registry lives on the RPC server, which is constructed with this runtime;
      // a closure defers the lookup past that ordering instead of inverting ownership.
      getPairedDeviceName?: (pairedDeviceId: string) => string | null
      // Why: codex-home paths for the Agent Session History scan must be sourced
      // here, not via the window-only registerCoreHandlers path — that path never
      // runs under `orca serve`, so remote/SSH hosts would silently drop
      // managed-Codex sessions. The runtime ctor runs in BOTH window and serve.
      getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
      prepareAiVaultSessionResume?: (
        args: AiVaultPrepareSessionResumeArgs
      ) => Promise<AiVaultPrepareSessionResumeResult>
      prepareCodexStructuredLaunch?: (input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>
      buildAgentHookPtyEnv?: () => Record<string, string>
      getDesktopWindowStatus?: () => RuntimeDesktopWindowStatus
      agentSessionClaimSigner?: AgentSessionClaimSigner
      skillTransactionRecovery?: Promise<unknown>
      orchestrationEnvironmentTransport?: OrchestrationEnvironmentTransport
    }
  ) {
    super()
    this.store = store
    store?.onSettingsChanged?.((updates) => {
      if ('experimentalStructuredNativeChat' in updates) {
        this.notifyMobileSessionTabsChanged()
      }
    })
    const runtime = this as RuntimeCommandSurfaceHost<this>
    installRuntimeFileCommandSurface(runtime, this.fileCommands)
    installRuntimeGitCommandSurface(runtime, this.gitCommands)
    installRuntimeRepositoryCommandSurface(runtime, {
      projectHostSetups: this.projectHostSetups,
      projectGroups: this.projectGroups,
      nestedRepoImport: this.nestedRepoImport,
      serverEnvironment: this.serverEnvironment,
      repositorySparsePresets: this.repositorySparsePresets,
      repositoryRegistrations: this.repositoryRegistrations,
      repositoryClones: this.repositoryClones,
      repositorySettings: this.repositorySettings,
      repositoryRefQueries: this.repositoryRefQueries,
      hostedReviews: this.hostedReviews,
      gitHubRepositoryQueries: this.gitHubRepositoryQueries,
      repositoryHooks: this.repositoryHooks,
      repositoryIssueCommand: this.repositoryIssueCommand
    })
    installRuntimeReviewCommandSurface(runtime, {
      gitLabQueries: this.gitLabQueryCommands,
      gitLabMutations: this.gitLabMutationCommands,
      gitHubReviewQueries: this.gitHubReviewQueries,
      gitHubReviewMutations: this.gitHubReviewMutations,
      gitHubIssueComments: this.gitHubIssueComments,
      gitHubProjects: this.gitHubProjectCommands
    })
    installRuntimeServiceCommandSurface(runtime, {
      aiVault: this.aiVault,
      clientEvents: this.clientEvents,
      nativeChatDraftResolutions: this.nativeChatDraftResolutions,
      subscriptions: this.subscriptions,
      mobileNotifications: this.mobileNotifications,
      accounts: this.accounts,
      mobileSpeech: this.mobileSpeech,
      mobileDictation: this.mobileDictation,
      browserDrivers: this.browserDrivers,
      messageWaiters: this.messageWaiters
    })
    this.skillCommands = new RuntimeSkillCommands({
      getRuntimeId: () => this.runtimeId,
      getUserDataPath: () => getAppEnvironment().getPath('userData'),
      isPackaged: () => getAppEnvironment().isPackaged(),
      getSettings: () => this.store?.getSettings?.() ?? {},
      listRepos: () => this.listRepos(),
      listFolderWorkspaces: () =>
        (this.store?.getFolderWorkspaces?.() ?? []).map((workspace) => ({
          id: workspace.id,
          folderPath: workspace.folderPath,
          connectionId: workspace.connectionId,
          executionHostId: workspace.executionHostId
        })),
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      showManagedWorktree: (selector) => this.showManagedWorktree(selector),
      resolveProjectRuntimeForWorktree: (worktreeId) =>
        this.resolveProjectRuntimeForWorktree(worktreeId),
      getSshProvider: (connectionId) => this.getSshProviderFn?.(connectionId),
      getClaudeConfigDirectory: (target) => this.accounts.getClaudeConfigDirectory(target),
      skillTransactionRecovery: (deps?.skillTransactionRecovery ?? Promise.resolve()).catch(
        (error) => {
          console.warn('[skills] startup transaction recovery failed:', error)
        }
      )
    })
    installRuntimeSkillCommandSurface(runtime, this.skillCommands)
    Object.assign(this, this.edgeCommands.surface)
    // Why: keep cache-boundary test seams live while the fetch owner holds the mutable maps.
    void this.canonicalFetchKeyCache
    void this.fetchLastCompletedAt
    this.clientSettings = new RuntimeClientSettingsController(store, () =>
      this.notifyReposChanged()
    )
    this.automation = new RuntimeAutomationController(store, {
      showRepo: (selector) => runtime.showRepo(selector),
      showManagedWorktree: (selector) => this.showManagedWorktree(selector)
    })
    // Why: per-device tab selections must survive host restarts, or every phone snaps back to the first tab on return.
    const persistedClientTabSelections = store?.getMobileClientTabSelections?.()
    if (persistedClientTabSelections) {
      this.clientSessionTabSelections.hydrate(persistedClientTabSelections)
    }
    this.clientSessionTabSelections.setPersistListener((state) => {
      this.store?.setMobileClientTabSelections?.(state)
    })
    this.orchestrationEnvironmentTransport = deps?.orchestrationEnvironmentTransport ?? null
    this.orchestrationFederation = new RuntimeOrchestrationFederation(
      runtime,
      this.orchestrationEnvironmentTransport
    )
    if (stats) {
      this.stats = stats
    }
    this.getAgentStatusSnapshotFn = deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionSnapshotFn =
      deps?.getAgentProviderSessionSnapshot ?? deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionRowsForPaneFn = deps?.getAgentProviderSessionRowsForPane ?? null
    this.attestAgentHookCompatibilityAuthorityFn =
      deps?.attestAgentHookCompatibilityAuthority ?? null
    this.retireAgentHookCompatibilityAuthorityFn =
      deps?.retireAgentHookCompatibilityAuthority ?? null
    this.reconcileAgentStatusForEndedProcessFn = deps?.reconcileAgentStatusForEndedProcess ?? null
    this.canRecoverPersistentLocalPtysFn = deps?.canRecoverPersistentLocalPtys ?? (() => true)
    this.getPairedDeviceNameFn = deps?.getPairedDeviceName ?? (() => null)
    // Why: configure the shared AiVault scan cache from a serve-mode-reachable
    // seam so the aiVault.listSessions RPC includes managed-Codex + WSL sessions
    // even on headless `orca serve` hosts where registerCoreHandlers never runs.
    if (deps?.getAdditionalAiVaultCodexHomePaths) {
      configureAiVaultSessionSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
      configureHostReadableTranscriptPathSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
    }
    // Why: the daemon adapter is installed via `setLocalPtyProvider()` during
    // attachMainWindowServices, AFTER this service is constructed. Capturing
    // `getLocalPtyProvider()` at construction time would freeze a reference to
    // the pre-daemon `LocalPtyProvider` and miss the routed adapter. Resolve
    // lazily via thunk so teardown always sees the currently-installed
    // provider (design §4.3 wire-up).
    this.getLocalProviderFn = deps?.getLocalProvider ?? null
    this.getSshProviderFn = deps?.getSshProvider ?? null
    this.onPtyStopped = deps?.onPtyStopped ?? null
    this.onTerminalAgentStatus = deps?.onTerminalAgentStatus ?? null
    this.buildAgentHookPtyEnv = deps?.buildAgentHookPtyEnv ?? null
    this.getDesktopWindowStatusFn = deps?.getDesktopWindowStatus ?? (() => 'openable')
    this.prepareAiVaultSessionResumeFn = deps?.prepareAiVaultSessionResume ?? null
    this.prepareCodexStructuredLaunchFn = deps?.prepareCodexStructuredLaunch ?? null
    this.agentSessionClaimSigner =
      deps?.agentSessionClaimSigner ?? createEphemeralAgentSessionClaimSigner(this.runtimeId)
    this.onTerminalSideEffects = deps?.onTerminalSideEffects ?? null
    // Why: the ConPTY spawn mark can land after daemon stream data already
    // created this PTY's emulator; the mark retrofits the DA1 override here
    // (terminal-query-authority.md §ConPTY DA1).
    registerConptyDa1OverrideInstaller((ptyId) => this.ensureNativeWindowsConptyDa1Override(ptyId))
    // Why: a renderer attribute push must reach already-live emulators too —
    // cursor options for DECRQSS/DECRQM parity plus the per-PTY OSC color
    // override reset a theme apply implies (terminal-query-authority.md
    // §View-attribute bridge).
    registerTerminalViewAttributesApplier((attributes) => {
      for (const state of this.headlessTerminals.values()) {
        state.emulator.applyPushedViewAttributes(attributes)
      }
    })
  }
}
