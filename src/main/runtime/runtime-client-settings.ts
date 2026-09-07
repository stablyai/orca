import { getAppEnvironment } from '../../shared/app-environment'
import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'
import { isAgentSkillSharingEnabled } from '../../shared/agent-skill-sharing-gate'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import { TASK_PROVIDERS } from '../../shared/task-providers'
import {
  applyTerminalQuickCommandMutation,
  MAX_QUICK_COMMANDS,
  type TerminalQuickCommandMutation
} from '../../shared/terminal-quick-commands'
import { haveSameDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getHostDisplayLabelOverrides } from '../../shared/host-setting-overrides'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import type { RuntimeStore } from './runtime-store-contract'

export type RuntimeClientSettings = Pick<
  GlobalSettings,
  | 'defaultTuiAgent'
  | 'disabledTuiAgents'
  | 'agentCmdOverrides'
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentStatusHooksEnabled'
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'visibleTaskProviders'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
  | 'experimentalNewWorktreeCardStyle'
  | 'experimentalStructuredNativeChat'
  | 'compactWorktreeCards'
  | 'minimaxGroupId'
  | 'minimaxUsageModels'
  | 'prBotAuthorOverrides'
  | 'artifactSharingEnabled'
  | 'worktreeVisibilityDefaults'
  | 'agentSkillSharingEnabled'
> & {
  hostSettingOverrides: RuntimeHostDisplayLabelOverrides
}

/** Safe paired projection: host labels only; filesystem defaults stay host-private. */
export type RuntimeHostDisplayLabelOverrides = Partial<
  Record<ExecutionHostId, { displayLabel: string }>
>

export type RuntimeClientSettingsUpdate = Pick<
  Partial<GlobalSettings>,
  | 'agentStatusHooksEnabled'
  | 'defaultTuiAgent'
  | 'disabledTuiAgents'
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'visibleTaskProviders'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
  | 'experimentalNewWorktreeCardStyle'
  | 'compactWorktreeCards'
  | 'minimaxGroupId'
  | 'minimaxUsageModels'
  | 'prBotAuthorOverrides'
  | 'worktreeVisibilityDefaults'
>

export class RuntimeClientSettingsController {
  private reconciliationGeneration = 0
  private reconciliationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: RuntimeStore | null,
    private readonly notifyReposChanged: (() => void) | undefined = undefined
  ) {}

  get(): RuntimeClientSettings {
    if (!this.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    return {
      defaultTuiAgent: settings.defaultTuiAgent ?? null,
      disabledTuiAgents: settings.disabledTuiAgents ?? [],
      agentCmdOverrides: settings.agentCmdOverrides ?? {},
      agentDefaultArgs: settings.agentDefaultArgs ?? {},
      agentDefaultEnv: settings.agentDefaultEnv ?? {},
      agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
      defaultTaskSource: settings.defaultTaskSource ?? 'github',
      defaultTaskViewPreset: settings.defaultTaskViewPreset ?? 'issues',
      visibleTaskProviders: settings.visibleTaskProviders ?? [...TASK_PROVIDERS],
      defaultRepoSelection: settings.defaultRepoSelection ?? null,
      defaultLinearTeamSelection: settings.defaultLinearTeamSelection ?? null,
      githubProjects: settings.githubProjects,
      experimentalNewWorktreeCardStyle: settings.experimentalNewWorktreeCardStyle === true,
      experimentalStructuredNativeChat: settings.experimentalStructuredNativeChat === true,
      compactWorktreeCards: settings.compactWorktreeCards === true,
      minimaxGroupId: settings.minimaxGroupId ?? '',
      minimaxUsageModels: settings.minimaxUsageModels ?? 'general',
      prBotAuthorOverrides: settings.prBotAuthorOverrides ?? [],
      artifactSharingEnabled: isArtifactSharingEnabled(settings),
      worktreeVisibilityDefaults: settings.worktreeVisibilityDefaults ?? { external: 'hide' },
      agentSkillSharingEnabled: isAgentSkillSharingEnabled(settings),
      hostSettingOverrides: Object.fromEntries(
        [
          ...getHostDisplayLabelOverrides({ hostSettingOverrides: settings.hostSettingOverrides })
        ].map(([hostId, displayLabel]) => [hostId, { displayLabel }])
      ) as RuntimeHostDisplayLabelOverrides
    }
  }

  async update(updates: RuntimeClientSettingsUpdate): Promise<RuntimeClientSettings> {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const beforeSettings = this.store.getSettings()
    const before = beforeSettings.agentStatusHooksEnabled !== false
    this.store.updateSettings(updates, { notifyListeners: true })
    const settings = this.store.getSettings()
    if (updates.worktreeVisibilityDefaults !== undefined) {
      this.notifyReposChanged?.()
    }
    if (
      (typeof updates.agentStatusHooksEnabled === 'boolean' &&
        before !== updates.agentStatusHooksEnabled) ||
      (updates.disabledTuiAgents !== undefined &&
        !haveSameDisabledTuiAgents(beforeSettings.disabledTuiAgents, settings.disabledTuiAgents))
    ) {
      await this.reconcileManagedAgentHooks()
    }
    return this.get()
  }

  getTerminalQuickCommands(): TerminalQuickCommand[] {
    if (!this.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    return this.store.getSettings().terminalQuickCommands ?? []
  }

  updateTerminalQuickCommands(mutation: TerminalQuickCommandMutation): TerminalQuickCommand[] {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = this.getTerminalQuickCommands()
    if (
      mutation.type === 'upsert' &&
      !current.some((command) => command.id === mutation.command.id) &&
      current.length >= MAX_QUICK_COMMANDS
    ) {
      throw new Error('Quick command limit reached')
    }
    const next = applyTerminalQuickCommandMutation(current, mutation)
    this.store.updateSettings({ terminalQuickCommands: next }, { notifyListeners: true })
    return this.getTerminalQuickCommands()
  }

  updatePRBotAuthorOverride(args: { author: string; isBot: boolean }): RuntimeClientSettings {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = this.store.getSettings().prBotAuthorOverrides
    this.store.updateSettings(
      { prBotAuthorOverrides: applyPRBotAuthorOverride(current, args.author, args.isBot) },
      { notifyListeners: true }
    )
    return this.get()
  }

  private reconcileManagedAgentHooks(): Promise<void> {
    const generation = ++this.reconciliationGeneration
    const reconciliation = this.reconciliationTail.then(async () => {
      if (generation !== this.reconciliationGeneration) {
        return
      }
      const settings = this.store?.getSettings()
      if (!settings) {
        return
      }
      await applyAgentStatusHooksEnabled(settings.agentStatusHooksEnabled !== false, settings, {
        shouldHydrateShellPath: getAppEnvironment().isPackaged(),
        onInstallError: recordManagedHookInstallFailure,
        shouldContinue: (agent) => {
          const current = this.store?.getSettings()
          return (
            current !== undefined &&
            current.agentStatusHooksEnabled !== false &&
            !current.disabledTuiAgents?.includes(agent)
          )
        }
      })
    })
    this.reconciliationTail = reconciliation.catch(() => {})
    return reconciliation
  }
}
