import type { GlobalSettings } from '../../../../../src/shared/settings/global-settings-types'
import type { Repo } from '../../../../../src/shared/repository/repo-types'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import { resolveSourceControlActionRecipe } from '../../../../../src/shared/source-control/ai/source-control-ai-operation-policy'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../../../src/shared/source-control/ai/source-control-launch-agent-selection'
import {
  filterEnabledTuiAgents,
  isTuiAgentEnabled
} from '../../../../../src/shared/agent-launch/catalog/tui-agent-selection'
import {
  resolveSourceControlActionPreferredSurface,
  resolveSourceControlActionRequestedSurface
} from '../../../../../src/shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-launch/installation/managed-runtime-install'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { NativeChatDefaultSettings } from '../../../../../src/shared/agent-launch/choices/structured-native-chat-launch-route'
import { hostStartsAgentAsChat } from '../../../session/agent-launch/new-tab-agent-surface'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import {
  registeredAgentChatInstallable,
  type AgentSessionRegisteredAgent
} from '../../../../../src/shared/agent-session/agent-discovery/agent-session-registered-agents'
import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent as isMobileTuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { translate } from '../../../i18n/mobile-i18n'
import type { MobileAgentLaunchContext } from '../../../session/agent-launch/mobile-new-tab-agent-loader'

export type MobileSourceControlLaunchAgent =
  | {
      kind: 'agent'
      agent: TuiAgent
      recipe: SourceControlActionRecipe | null
      /** No CLI was detected, so only an explicit chat can start it. */
      chatOnly: boolean
    }
  | { kind: 'unavailable'; message: string }

type LaunchAgentSettings = Pick<
  GlobalSettings,
  'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent' | 'disabledTuiAgents'
> & { nativeChatDefaults?: NativeChatDefaultSettings | null }

/** The host can run an agent's chat on a program it installs, and refuses an explicit chat it can't open. */
export function hostOpensChatsWithoutCli(hostCapabilities: readonly string[]): boolean {
  return (
    hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) &&
    hostCapabilities.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY) &&
    hostCapabilities.includes(MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY) &&
    hostCapabilities.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY)
  )
}

/** What the host says about running agents as chats; absent facts open nothing as a chat. */
export type MobileLaunchChatHost = {
  hostCapabilities: readonly string[]
  registeredAgents: readonly AgentSessionRegisteredAgent[] | null | undefined
}

export function resolveMobileSourceControlLaunchAgent(
  context: MobileAgentLaunchContext,
  actionId: SourceControlLaunchActionId | null,
  chatHost?: MobileLaunchChatHost
): MobileSourceControlLaunchAgent {
  const settings = readLaunchAgentSettings(context.settings)
  const detectedAgents = context.detectedAgents.filter(isMobileTuiAgent)
  const recipe = actionId ? readSavedRecipe(settings, context.repo, actionId) : null
  const savedAgent = readSourceControlLaunchRecipeAgentId(recipe)
  // As desktop: an agent without a CLI is usable when the host opens it as a chat it installs itself.
  const opensAsChat = (agent: TuiAgent): boolean =>
    !!chatHost &&
    hostOpensChatsWithoutCli(chatHost.hostCapabilities) &&
    // SSH workspaces run agents in terminals only.
    !context.repo?.connectionId &&
    (recipe === null || resolveSourceControlActionRequestedSurface(recipe, agent) !== 'terminal') &&
    ((recipe !== null && resolveSourceControlActionPreferredSurface(recipe, agent) === 'chat') ||
      hostStartsAgentAsChat(settings?.nativeChatDefaults, agent)) &&
    registeredAgentChatInstallable(chatHost.registeredAgents, agent, chatHost.hostCapabilities)
  const enabledDetected = filterEnabledTuiAgents(detectedAgents, settings?.disabledTuiAgents)
  // No pre-launch dialog can show a substitution; fail an unavailable saved agent instead of silently swapping it.
  if (
    savedAgent &&
    !enabledDetected.includes(savedAgent) &&
    !(isTuiAgentEnabled(savedAgent, settings?.disabledTuiAgents) && opensAsChat(savedAgent))
  ) {
    return {
      kind: 'unavailable',
      message: translate(
        'session.sourceControlLaunchAgent.savedAgentUnavailable',
        'The saved agent for this action is not available on this workspace host.'
      )
    }
  }
  const agent = pickSourceControlLaunchAgent({
    savedAgent,
    defaultAgent: settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents,
    chosenOpensAsChat: opensAsChat
  })
  return agent
    ? { kind: 'agent', agent, recipe, chatOnly: !enabledDetected.includes(agent) }
    : {
        kind: 'unavailable',
        message: translate(
          'session.sourceControlLaunchAgent.noEnabledAgent',
          'No enabled AI agent was detected on this workspace host.'
        )
      }
}

function readLaunchAgentSettings(settings: unknown): LaunchAgentSettings | null {
  if (!settings || typeof settings !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.get answers with the host's GlobalSettings, and every member read here goes through a normalizer or an enabled-agent filter.
  return settings as LaunchAgentSettings
}

function readSavedRecipe(
  settings: LaunchAgentSettings | null,
  repo: unknown,
  actionId: SourceControlLaunchActionId
): SourceControlActionRecipe | null {
  try {
    return resolveSourceControlActionRecipe({ settings, repo: readRepoOverrides(repo), actionId })
  } catch {
    // A recipe the phone cannot read must not block the button; the default agent still applies.
    return null
  }
}

function readRepoOverrides(repo: unknown): Pick<Repo, 'sourceControlAi'> | null {
  return repo && typeof repo === 'object' && 'sourceControlAi' in repo
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe resolver normalizes this member from unknown (normalizeRepoSourceControlAiOverrides).
      { sourceControlAi: repo.sourceControlAi as Repo['sourceControlAi'] }
    : null
}
