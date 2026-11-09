import { publishedLegacyChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { getClaudeAgentViewService } from '../../../claude/agent-view/agent-view-service'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { isArtifactSharingEnabled } from '../../../../shared/artifacts/artifact-sharing-gate'
import { isAgentSkillSharingEnabled } from '../../../../shared/agent-skill-sharing-gate'
import { applyPRBotAuthorOverride } from '../../../../shared/source-control/review-comments/pr-bot-author-overrides'
import { TASK_PROVIDERS } from '../../../../shared/work-items/task-providers'
import {
  applyTerminalQuickCommandMutation,
  type TerminalQuickCommandMutation
} from '../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { haveSameDisabledTuiAgents } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { normalizeSourceControlGroupOrder } from '../../../../shared/source-control/listing/source-control-group-order'
import { SOURCE_CONTROL_LAUNCH_ACTION_IDS } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { applyNativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { NativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat/input/native-chat-session-options'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { nativeChatShowsCiResultLines } from '../../../../shared/native-chat/native-chat-appearance-settings'
import type { TerminalQuickCommand } from '../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { recordManagedHookInstallFailure } from '../../../agent-hooks/installation/install-telemetry'
import { applyAgentStatusHooksEnabled } from '../../../agent-hooks/installation/managed-agent-hook-controls'
import { isWslHostOrcadProcess } from '../../../ipc/wsl-guest-windows-drive-path'
import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { permissionGuardSkipInUse } from '../../../../shared/agent-launch/permissions/agent-permission-guard-skip'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch/choices/agent-launch-settings'
import { legacyLaunchTextUpdates } from '../../../../shared/agent-launch/choices/agent-launch-permission-updates'
import { composeAgentLaunchProfile } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { agentLaunchSettingsRollbackUpdates } from '../../terminal/launch/agent-launch-settings-rollback'
import type {
  RuntimeClientSettings,
  RuntimeClientSettingsUpdate,
  RuntimeClientSourceControlAi,
  RuntimeHostDisplayLabelOverrides
} from './runtime-client-settings-shape'

/** Which Orca cloud services this host registered; headless hosts register none. */
export type RuntimeSharingServicePresence = {
  artifacts(): boolean
  skills(): boolean
}

export class RuntimeClientSettingsController {
  private reconciliationGeneration = 0
  private reconciliationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: Pick<
      RuntimeStore,
      'getSettings' | 'updateSettings' | 'runDurableMutation'
    > | null,
    private readonly notifyReposChanged: (() => void) | undefined = undefined,
    private readonly sharingServices: RuntimeSharingServicePresence | undefined = undefined
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
      // Always present, so a client can tell this host accepts the setting (older hosts omit it).
      codexShareHistoryAcrossAccounts: settings.codexShareHistoryAcrossAccounts !== false,
      claudeSubagentNavigationEnabled: settings.claudeSubagentNavigationEnabled !== false,
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
      compactWorktreeCards: settings.compactWorktreeCards === true,
      minimaxGroupId: settings.minimaxGroupId ?? '',
      minimaxUsageModels: settings.minimaxUsageModels ?? 'general',
      minimaxEndpoint: settings.minimaxEndpoint ?? 'overseas',
      zcodePlanSite: settings.zcodePlanSite ?? 'zai',
      prBotAuthorOverrides: settings.prBotAuthorOverrides ?? [],
      // Paired clients order their Source Control lists the way this desktop does.
      sourceControlGroupOrder: normalizeSourceControlGroupOrder(settings.sourceControlGroupOrder),
      sourceControlCompareAgainstUpstream: settings.sourceControlCompareAgainstUpstream === true,
      diffShowWhitespace: settings.diffShowWhitespace === true,
      // Omitted without a service: clients treat absence as "ask the host", which names the real cause.
      ...(this.sharingServices?.artifacts() === false
        ? {}
        : { artifactSharingEnabled: isArtifactSharingEnabled(settings) }),
      worktreeVisibilityDefaults: settings.worktreeVisibilityDefaults ?? { external: 'hide' },
      ...(this.sharingServices?.skills() === false
        ? {}
        : { agentSkillSharingEnabled: isAgentSkillSharingEnabled(settings) }),
      nativeChatAutoContinueAfterUsageLimit:
        settings.nativeChatAutoContinueAfterUsageLimit === true,
      machineName: settings.machineName ?? '',
      // A paired browser dictates through this host, which refuses unless these allow it.
      voice: {
        enabled: settings.voice?.enabled === true,
        sttModel: settings.voice?.sttModel ?? ''
      },
      nativeChatPermissionMode: publishedLegacyChatPermissionMode(settings),
      // Mirror the host preference; delivery still depends on queue capability.
      nativeChatQueueFollowUps: nativeChatQueueFollowUps(settings),
      // Resolved, so a phone can tell a reported value from an older host's absence.
      nativeChatCiResultLines: nativeChatShowsCiResultLines(settings),
      // Why projected: a paired client's AI buttons start these actions' agents, and must honour
      // the agent saved for each one as the desktop does. Absent on older hosts.
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
    const { agentDefaultArgs, agentDefaultEnv, ...otherUpdates } = updates
    // Legacy clients can select an agent or a shell, but cannot select None.
    this.store.updateSettings(
      {
        ...otherUpdates,
        // An older client writes Arguments as it reads them, flag included.
        ...(agentDefaultArgs !== undefined || agentDefaultEnv !== undefined
          ? legacyLaunchTextUpdates(
              beforeSettings,
              { agentDefaultArgs, agentDefaultEnv },
              process.platform
            )
          : {}),
        ...(updates.defaultTuiAgent !== undefined ? { newWorkspaceSetupOnly: false } : {})
      },
      { notifyListeners: true }
    )
    const settings = this.store.getSettings()
    await getClaudeAgentViewService().reconcile(settings)
    if (updates.worktreeVisibilityDefaults !== undefined) {
      this.notifyReposChanged?.()
    }
    if (
      // An explicit enable while already enabled is a repair request (`orca agent hooks on`), so a wiped hook config reinstalls.
      updates.agentStatusHooksEnabled === true ||
      (typeof updates.agentStatusHooksEnabled === 'boolean' &&
        before !== updates.agentStatusHooksEnabled) ||
      (updates.disabledTuiAgents !== undefined &&
        !haveSameDisabledTuiAgents(beforeSettings.disabledTuiAgents, settings.disabledTuiAgents)) ||
      claudePermissionHookPlanChanged(beforeSettings, settings)
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
            (updates.disabledTuiAgents !== undefined &&
              !haveSameDisabledTuiAgents(before.disabledTuiAgents, applied.disabledTuiAgents)) ||
            claudePermissionHookPlanChanged(before, applied)
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
        // R42, COMPAT(wsl-bridge): the bridge's panes in this distro share these entries; drop at D4.
        keepSharedEntries: isWslHostOrcadProcess(),
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

type HookPlanSettings = Parameters<typeof isAgentStatusHooksEnabledForAgent>[0] &
  Parameters<typeof permissionGuardSkipInUse>[0]

// The guard skip retires Orca's PermissionRequest hook, which every Claude session shares.
function claudePermissionHookPlanChanged(before: HookPlanSettings, after: HookPlanSettings) {
  return (
    isAgentStatusHooksEnabledForAgent(after, 'claude') &&
    permissionGuardSkipInUse(before) !== permissionGuardSkipInUse(after)
  )
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
