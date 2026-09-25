/**
 * Which agent a source-control AI button starts from the phone: the desktop's own resolution
 * (`pickSourceControlLaunchAgent`), fed the same saved recipe, default agent and detected agents.
 */

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
import type { MobileAgentLaunchContext } from './mobile-new-tab-agent-loader'

export type MobileSourceControlLaunchAgent =
  /** `recipe`: the action's saved prompt template and agent arguments; null with no action. */
  | { kind: 'agent'; agent: TuiAgent; recipe: SourceControlActionRecipe | null }
  | { kind: 'unavailable'; message: string }

type LaunchAgentSettings = Pick<
  GlobalSettings,
  'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent' | 'disabledTuiAgents'
>

export function resolveMobileSourceControlLaunchAgent(
  context: MobileAgentLaunchContext,
  // Null for a launch with no saved recipe, such as sending review notes.
  actionId: SourceControlLaunchActionId | null
): MobileSourceControlLaunchAgent {
  const settings = readLaunchAgentSettings(context.settings)
  const detectedAgents = context.detectedAgents.filter(isMobileTuiAgent)
  const recipe = actionId ? readSavedRecipe(settings, context.repo, actionId) : null
  const savedAgent = readSourceControlLaunchRecipeAgentId(recipe)
  // Why: the phone has no pre-launch dialog showing the pick, so a saved agent that can't run here
  // is an error, as on the desktop's direct launch, rather than a silent swap to another agent.
  if (
    savedAgent &&
    !filterEnabledTuiAgents(detectedAgents, settings?.disabledTuiAgents).includes(savedAgent)
  ) {
    return {
      kind: 'unavailable',
      message: 'The saved agent for this action is not available on this workspace host.'
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
    : { kind: 'unavailable', message: 'No enabled AI agent was detected on this workspace host.' }
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
