import { ensureStructuredAgentModelCatalogOwner } from '../model-catalog/structured-agent-model-catalog-wiring'
import type { StructuredAgentModelCatalogDeps } from './structured-agent-runtime-registration-types'
import { resolveStructuredCodexAccountKind } from '../environment/structured-agent-account-home'
import { nativeChatShellEnvironmentPolicy } from '../../../../shared/native-chat/native-chat-shell-environment'
import { claudeStructuredAuthPolicyForSettings } from '../../../claude-accounts/runtime-auth/claude-structured-auth-policy'
import { resolveStructuredAgentCommand } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { structuredAgentConfiguredArgs } from '../../../native-chat/agent-launch/structured-agent-configured-args'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { overlayEnvironmentVariables } from '../../../../shared/environment-overlay'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { RuntimeWorkspaceCatalog } from '../../workspaces/catalog/workspace-catalog'
import type { OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController } from '../../terminal/lifecycle/pty-worktree-refresh'
import type { RuntimeAccountController } from '../environment/runtime-account-controller'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from '../../session-tabs/structured-session-create-support'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from '../../terminal/wait/terminal-wait-visible-probe'
import {
  hostShellEnvironment,
  hostShellEnvironmentRevision
} from '../environment/structured-agent-shell-environment'
import { usageLimitAccountSources } from './usage-limit-account-usage'
import { claudeLaunchAccountHoldsLogin } from '../../../claude-accounts/runtime-auth/claude-launch-login'

/** A sign-in stamps the account list; a selection moves these too. */
const CLAUDE_ACCOUNT_SETTINGS = [
  'claudeManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime'
] as const

export abstract class RuntimeStructuredAgentHost extends OrcaRuntimeWithStartTuiIdleVisibleReadProbe {
  /** Apply the host-owning desktop's account overlay to configured agent environment. */
  protected structuredAgentLaunchEnv(
    agent: StructuredAgentId,
    settings: Pick<GlobalSettings, 'agentDefaultEnv'>
  ) {
    return overlayEnvironmentVariables(
      overlayEnvironmentVariables({}, resolveTuiAgentLaunchEnv(agent, settings), process.platform),
      this.accounts.hostLaunchEnvFor(agent),
      process.platform
    )
  }

  protected structuredAgentCatalogDependencies(): StructuredAgentModelCatalogDeps {
    return {
      stateDirectory: getProfileUserDataPath(),
      // Resolve plain folder workspaces as well as git worktrees.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveClaudeCommand: (options) =>
        resolveStructuredAgentCommand('claude', this.requireStore().getSettings(), options),
      resolveCodexCommand: (options) =>
        resolveStructuredAgentCommand('codex', this.requireStore().getSettings(), options),
      resolveLaunchArgs: (agent) =>
        structuredAgentConfiguredArgs(agent, this.requireStore().getSettings()),
      resolveShellEnvironmentPolicy: () =>
        nativeChatShellEnvironmentPolicy(this.requireStore().getSettings()),
      resolveClaudeAuthPolicy: () =>
        claudeStructuredAuthPolicyForSettings(this.requireStore().getSettings()),
      resolveAgentLaunchEnv: (agent) =>
        isTuiAgent(agent)
          ? this.structuredAgentLaunchEnv(agent, this.requireStore().getSettings())
          : {},
      resolveAgentCommandSettings: () => this.requireStore().getSettings(),
      resolveCodexAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, this.requireStore().getSettings()),
      resolveAgentAccountHome: (agent) => this.resolveStructuredAgentAccountHome(agent),
      ...(this.prepareCodexCatalogProbeHomeFn
        ? { prepareCodexCatalogProbeHome: this.prepareCodexCatalogProbeHomeFn }
        : {})
    }
  }

  async structuredAgentModelCatalog() {
    return (await ensureStructuredAgentModelCatalogOwner(this.structuredAgentCatalogDependencies()))
      .modelCatalog
  }

  /** Read the setting live so turning it off stops every pending automatic continuation. */
  protected usageLimitAutoContinueHostDeps(): StructuredAgentSessionHostDeps['usageLimitAutoContinue'] {
    return {
      isEnabled: () =>
        this.requireStore().getSettings().nativeChatAutoContinueAfterUsageLimit === true,
      subscribe: (changed) => this.requireStore().onSettingsChanged?.(changed) ?? (() => {}),
      isWorkspaceAsleep: (workspaceId) => this.isWorktreeTerminalSleepHeld(workspaceId),
      ...usageLimitAccountSources({
        rateLimits: () => this.accounts.usageRateLimits(),
        settings: () => this.requireStore().getSettings(),
        // The last capture: this runs every sweep pass and must not start a login shell.
        shellEnvironment: () => hostShellEnvironment(true),
        shellEnvironmentRevision: hostShellEnvironmentRevision,
        claudeLaunchEnv: (settings) => this.structuredAgentLaunchEnv('claude', settings)
      })
    }
  }

  /** What the chat host takes from this runtime's accounts. */
  protected accountHostDeps(): Pick<
    StructuredAgentSessionHostDeps,
    'usageLimitAutoContinue' | 'signedOutRetry'
  > {
    return {
      usageLimitAutoContinue: this.usageLimitAutoContinueHostDeps(),
      signedOutRetry: this.signedOutRetryHostDeps()
    }
  }

  /** Only Claude refuses a start for want of a login; Codex reports it inside the turn it ran. */
  protected signedOutRetryHostDeps(): StructuredAgentSessionHostDeps['signedOutRetry'] {
    return {
      // A WSL chat launches on the guest's login, which the host's router doesn't read.
      launchAccountSignedIn: async ({ provider, location }) =>
        provider === 'claude' && !location.wslDistro && (await claudeLaunchAccountHoldsLogin()),
      // Orca's sign-ins and selections write settings; a login made outside Orca shows in usage.
      subscribe: (changed) => {
        const settings = this.requireStore().onSettingsChanged?.((updates) => {
          if (CLAUDE_ACCOUNT_SETTINGS.some((key) => key in updates)) {
            changed()
          }
        })
        // Every provider's poll pushes state; only Claude's reading changing can mean a login is back.
        let claude: string | undefined
        const usage = this.accounts.usageRateLimits()?.onStateChange((state) => {
          const reading = state.claude
          const seen = JSON.stringify([reading?.status, reading?.usageMetadata?.failureKind])
          if (seen !== claude) {
            claude = seen
            changed()
          }
        })
        return () => {
          settings?.()
          usage?.()
        }
      }
    }
  }

  protected abstract listResolvedWorktreeSnapshot(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>

  protected abstract refreshPtyWorktreeRecordsFromController(
    ...args: Parameters<
      OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
    >
  ): ReturnType<
    OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
  >

  protected abstract isWorktreeTerminalSleepHeld(workspaceId: string): boolean

  abstract notifyFolderWorkspaceChanged(): void

  abstract notifyBranchRenamed(repoId: string): void

  abstract notifyWorktreeFolderRenamed(
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ): void

  declare getCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['getCommitMessageAgentEnvironment']

  abstract refreshStructuredConversationTabTitle(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
    >
  ): ReturnType<
    OrcaRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
  >

  abstract resolveStructuredAgentAccountHome(
    ...args: Parameters<
      OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
    >
  ): ReturnType<
    OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
  >

  abstract resolveStructuredAgentLaunchAccountHome(
    ...args: Parameters<
      OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
    >
  ): ReturnType<
    OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
  >

  abstract prepareStructuredAgentLaunchAccountHome(
    ...args: Parameters<
      OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['prepareStructuredAgentLaunchAccountHome']
    >
  ): ReturnType<
    OrcaRuntimeWithGetStructuredAgentSessionCreateSupport['prepareStructuredAgentLaunchAccountHome']
  >

  protected abstract assertStructuredChatAcquireAdmissible(
    record: AgentSessionRecord
  ): Promise<void>
}
