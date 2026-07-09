import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { GlobalSettings, TuiAgent } from '../../shared/types'

type WikiAgentSettings = Pick<
  GlobalSettings,
  'defaultTuiAgent' | 'disabledTuiAgents' | 'sourceControlAi'
>

export function resolveWikiGenerationAgent(
  settings: WikiAgentSettings
): { ok: true; agent: TuiAgent } | { ok: false; error: string } {
  const preferred = settings.sourceControlAi?.agentId
  const candidate =
    preferred && preferred !== 'custom' && isTuiAgent(preferred)
      ? preferred
      : settings.defaultTuiAgent &&
          settings.defaultTuiAgent !== 'blank' &&
          isTuiAgent(settings.defaultTuiAgent)
        ? settings.defaultTuiAgent
        : null
  if (!candidate) {
    return { ok: false, error: 'No coding agent is configured. Set a default agent in Settings.' }
  }
  if (!isTuiAgentEnabled(candidate, settings.disabledTuiAgents ?? [])) {
    return { ok: false, error: `The configured agent "${candidate}" is disabled.` }
  }
  return { ok: true, agent: candidate }
}
