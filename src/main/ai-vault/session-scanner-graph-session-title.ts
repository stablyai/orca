import { cloneSessionAccumulator } from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'
import { extractString, normalizeTitleText } from './session-scanner-values'

export type GraphSessionAgent = 'openclaw' | 'pi' | 'omp' | 'prime-agent'
export type GraphSessionTitleSource = 'user' | 'auto'

export type GraphSessionTitleState = {
  agent: GraphSessionAgent
  accumulator: SessionAccumulator
  source: GraphSessionTitleSource | null
}

export function cloneGraphSessionTitleState(state: GraphSessionTitleState): GraphSessionTitleState {
  return {
    agent: state.agent,
    accumulator: cloneSessionAccumulator(state.accumulator),
    source: state.source
  }
}

// Harness names are persisted metadata; explicit names outrank automatic and prompt fallbacks.
export function applyGraphSessionTitle(
  state: GraphSessionTitleState,
  record: Record<string, unknown>
): void {
  const incoming = graphSessionTitleFromRecord(state.agent, record)
  if (!incoming) {
    return
  }
  if (state.source === 'user' && incoming.source !== 'user') {
    return
  }
  state.accumulator.title = incoming.title
  state.source = incoming.source
}

function graphSessionTitleFromRecord(
  agent: GraphSessionAgent,
  record: Record<string, unknown>
): { title: string; source: GraphSessionTitleSource } | null {
  const type = extractString(record.type)
  if (type === 'session_info') {
    const title = normalizeTitleText(extractString(record.name) ?? '')
    return title ? { title, source: 'user' } : null
  }
  if (agent !== 'omp' || (type !== 'title' && type !== 'title_change' && type !== 'session')) {
    return null
  }
  const title = normalizeTitleText(extractString(record.title) ?? '')
  if (!title) {
    return null
  }
  const raw = extractString(record.source) ?? extractString(record.titleSource)
  if (raw !== null && raw !== 'user' && raw !== 'auto') {
    return null
  }
  return { title, source: raw === 'user' ? 'user' : 'auto' }
}
