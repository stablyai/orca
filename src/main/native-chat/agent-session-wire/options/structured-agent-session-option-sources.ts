import type {
  AgentSessionAcceptedInputSources,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session/options/protocol/agent-session-options-result'

const ACCEPTED_OPTION_IDS = [
  'model',
  'effort',
  'fastMode',
  'serviceTier',
  'interactionMode',
  'contextMode'
] as const

export function structuredAgentSessionAcceptedInputSources(
  current: AgentSessionOptionsResult['current'],
  saved: Readonly<Record<string, unknown>>,
  selectedFastMode: boolean | undefined
): AgentSessionAcceptedInputSources {
  const sources: AgentSessionAcceptedInputSources = {}
  for (const key of ACCEPTED_OPTION_IDS) {
    if (current[key] !== undefined && saved[key] !== undefined) {
      sources[key] = 'saved'
    }
  }
  if (saved.fastMode === undefined && selectedFastMode === false) {
    sources.fastMode = 'policy'
  }
  return sources
}
