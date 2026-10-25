import { getAppEnvironment } from '../../shared/app-environment'
import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'
import { isAgentSkillSharingEnabled } from '../../shared/agent-skill-sharing-gate'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import { TASK_PROVIDERS } from '../../shared/task-providers'
import {
  applyTerminalQuickCommandMutation,
  type TerminalQuickCommandMutation
} from '../../shared/terminal-quick-commands'
import { haveSameDisabledTuiAgents } from '../../shared/tui-agent-selection'
import { normalizeSourceControlAiSettings } from '../../shared/source-control-ai'
import { SOURCE_CONTROL_LAUNCH_ACTION_IDS } from '../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { applyNativeChatSessionOptionSettingsMutation } from '../../shared/native-chat-session-option-defaults'
import type { NativeChatSessionOptionSettingsMutation } from '../../shared/native-chat-session-options'
import { getHostDisplayLabelOverrides } from '../../shared/host-setting-overrides'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { RuntimeStore } from './runtime-store-contract'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../shared/agent-launch-settings'
import { legacyLaunchTextUpdates } from '../../shared/agent-launch-permission-updates'
import { composeAgentLaunchProfile } from '../../shared/tui-agent-launch-defaults'
import { agentLaunchSettingsRollbackUpdates } from './agent-launch-settings-rollback'
import type {
  RuntimeClientSettings,
  RuntimeClientSettingsUpdate,
  RuntimeClientSourceControlAi,
  RuntimeHostDisplayLabelOverrides
} from './runtime-client-settings-shape'

export class RuntimeClientSettingsController {
  private reconciliationGeneration = 0
  private reconciliationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: Pick<
      RuntimeStore,
      'getSettings' | 'updateSettings' | 'runDurableMutation'
    > | null,
    private readonly notifyReposChanged: (() => void) | undefined = undefined
  ) {}

  get(): RuntimeClientSettings {
    if (!this.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    // Older clients read permission from composed argument text, before a stored choice existed.
    const launchProfile = composeAgentLaunchProfile(settings, process.platform)
    return {
      defaultTuiAgent: settings.defaultTuiAgent ?? null,
      newWorkspaceSetupOnly: false,
      disabledTuiAgents: settings.disabledTuiAgents ?? [],
      agentCmdOverrides: settings.agentCmdOverrides ?? {},
      agentDefaultArgs: launchProfile.agentDefaultArgs,
      agentDefaultEnv: launchProfile.agentDefaultEnv,
      agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
      // Mobile honors this Copy option; absence from older hosts means on (#19770).
      terminalCopyTrimsGutter: settings.terminalCopyTrimsGutter !== false,
      defaultTaskSource: settings.defaultTaskSource ?? 'github',
      defaultTaskViewPreset: settings.defaultTaskViewPreset ?? 'issues',
      visibleTaskProviders: settings.visibleTaskProviders ?? [...TASK_PROVIDERS],
      defaultRepoSelection: settings.defaultRepoSelection ?? null,
      // Persisted settings can violate the paired client's string-array contract.
      defaultLinearTeamSelection: Array.isArray(settings.defaultLinearTeamSelection)
        ? settings.defaultLinearTeamSelection.filter((id): id is string => typeof id === 'string')
        : null,
      githubProjects: settings.githubProjects,
      experimentalNewWorktreeCardStyle: settings.experimentalNewWorktreeCardStyle === true,
      experimentalNativeChat: settings.experimentalNativeChat === true,
      // Older clients use this key to fall back to terminal-backed chat. Keep their default terminal.
      openAgentTabsInChatByDefault: false,
      experimentalStructuredNativeChat: settings.experimentalNativeChat === true,
      compactWorktreeCards: settings.compactWorktreeCards === true,
      minimaxGroupId: settings.minimaxGroupId ?? '',
      minimaxUsageModels: settings.minimaxUsageModels ?? 'general',
      minimaxEndpoint: settings.minimaxEndpoint ?? 'overseas',
      zcodePlanSite: settings.zcodePlanSite ?? 'zai',
      prBotAuthorOverrides: settings.prBotAuthorOverrides ?? [],
      artifactSharingEnabled: isArtifactSharingEnabled(settings),
      worktreeVisibilityDefaults: settings.worktreeVisibilityDefaults ?? { external: 'hide' },
      agentSkillSharingEnabled: isAgentSkillSharingEnabled(settings),
      machineName: settings.machineName ?? '',
      // Paired web Chat settings edit this host's new-chat default.
      ...(settings.nativeChatPermissionMode
        ? { nativeChatPermissionMode: settings.nativeChatPermissionMode }
        : {}),
      ...(settings.agentNativeChatPermissionModes
        ? { agentNativeChatPermissionModes: settings.agentNativeChatPermissionModes }
        : {}),
      // Project per-action agent recipes so paired AI buttons honor host choices; older hosts omit them.
      sourceControlAi: projectSourceControlLaunchRecipes(settings),
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
    // Legacy clients can select an agent or a shell, but cannot select None.
    this.store.updateSettings(
      {
        ...updates,
        // An older client writes Arguments as it reads them, flag included.
        ...(updates.agentDefaultArgs !== undefined || updates.agentDefaultEnv !== undefined
          ? legacyLaunchTextUpdates(
              beforeSettings,
              {
                agentDefaultArgs: updates.agentDefaultArgs,
                agentDefaultEnv: updates.agentDefaultEnv
              },
              process.platform
            )
          : {}),
        ...(updates.nativeChatPermissionMode !== undefined
          ? { agentNativeChatPermissionModes: {} }
          : {}),
        ...(updates.defaultTuiAgent !== undefined ? { newWorkspaceSetupOnly: false } : {})
      },
      { notifyListeners: true }
    )
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

  getAgentLaunch(): AgentLaunchSettings {
    if (!this.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    return projectAgentLaunchSettings(this.store.getSettings(), process.platform)
  }

  async mutateAgentLaunch(mutation: AgentLaunchSettingsMutation): Promise<AgentLaunchSettings> {
    const store = this.store
    if (!store?.getSettings || !store.updateSettings || !store.runDurableMutation) {
      throw new Error('runtime_unavailable')
    }
    const applySettings = store.updateSettings.bind(store)
    const committed = await store.runDurableMutation(() => {
      const before = store.getSettings()
      const updates = agentLaunchSettingsMutationUpdates(before, mutation, process.platform)
      applySettings(updates, { notifyListeners: true })
      const applied = store.getSettings()
      return {
        value: {
          settings: projectAgentLaunchSettings(applied, process.platform),
          reconcileHooks:
            updates.disabledTuiAgents !== undefined &&
            !haveSameDisabledTuiAgents(before.disabledTuiAgents, applied.disabledTuiAgents)
        },
        rollback: () => {
          const rollback = agentLaunchSettingsRollbackUpdates(
            before,
            applied,
            store.getSettings(),
            updates
          )
          if (Object.keys(rollback).length > 0) {
            applySettings(rollback, { notifyListeners: true })
          }
        }
      }
    })
    if (committed.reconcileHooks) {
      void this.reconcileManagedAgentHooks().catch((error) => {
        console.error(
          '[agent-hooks] Failed to reconcile managed hooks after saving launch settings:',
          error
        )
      })
    }
    return committed.settings
  }

  updateTerminalQuickCommands(mutation: TerminalQuickCommandMutation): TerminalQuickCommand[] {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = this.getTerminalQuickCommands()
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

  updateNativeChatSessionOptions(mutation: NativeChatSessionOptionSettingsMutation): void {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const next = applyNativeChatSessionOptionSettingsMutation(
      this.store.getSettings().nativeChatSessionOptions,
      mutation
    )
    if (next) {
      this.store.updateSettings({ nativeChatSessionOptions: next }, { notifyListeners: true })
    }
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
          return current !== undefined && isAgentStatusHooksEnabledForAgent(current, agent)
        }
      })
    })
    this.reconciliationTail = reconciliation.catch(() => {})
    return reconciliation
  }
}

function projectSourceControlLaunchRecipes(
  settings: Partial<Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>>
): RuntimeClientSourceControlAi {
  const { actions } = normalizeSourceControlAiSettings(
    settings.sourceControlAi,
    settings.commitMessageAi
  )
  return {
    actions: Object.fromEntries(
      SOURCE_CONTROL_LAUNCH_ACTION_IDS.flatMap((actionId) => {
        const recipe = actions?.[actionId]
        return recipe ? [[actionId, recipe]] : []
      })
    )
  }
}
