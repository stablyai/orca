import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import type { Repo } from '../../../src/shared/repo-types'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../src/shared/source-control-ai-actions'
import { resolveSourceControlActionRecipe } from '../../../src/shared/source-control-ai'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../src/shared/source-control-launch-agent-selection'
import { filterEnabledTuiAgents } from '../../../src/shared/tui-agent-selection'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isMobileTuiAgent } from '../tasks/mobile-tui-agents'
import { translate } from '../i18n/mobile-i18n'
import type { MobileAgentLaunchContext } from './mobile-new-tab-agent-loader'

export type MobileSourceControlLaunchAgent =
  | { kind: 'agent'; agent: TuiAgent; recipe: SourceControlActionRecipe | null }
  | { kind: 'unavailable'; message: string }

type LaunchAgentSettings = Pick<
  GlobalSettings,
  'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent' | 'disabledTuiAgents'
>

export function resolveMobileSourceControlLaunchAgent(
  context: MobileAgentLaunchContext,
  actionId: SourceControlLaunchActionId | null
): MobileSourceControlLaunchAgent {
  const settings = readLaunchAgentSettings(context.settings)
  const detectedAgents = context.detectedAgents.filter(isMobileTuiAgent)
  const recipe = actionId ? readSavedRecipe(settings, context.repo, actionId) : null
  const savedAgent = readSourceControlLaunchRecipeAgentId(recipe)
  // No pre-launch dialog can show a substitution; fail an unavailable saved agent instead of silently swapping it.
  if (
    savedAgent &&
    !filterEnabledTuiAgents(detectedAgents, settings?.disabledTuiAgents).includes(savedAgent)
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
    disabledAgents: settings?.disabledTuiAgents
  })
  return agent
    ? { kind: 'agent', agent, recipe }
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
