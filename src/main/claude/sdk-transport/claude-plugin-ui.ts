import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { isProviderRecord } from '../../provider-process/provider-json-record'

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function claudeFocusedPlugin(message: Record<string, unknown>): string | null {
  if (message.type !== 'system' || message.subtype !== 'ui_panes') {
    return null
  }
  const paneId = nonemptyString(message.focus_requested_id)
  if (!paneId) {
    return null
  }
  const pane = Array.isArray(message.panes)
    ? message.panes.find((entry) => isProviderRecord(entry) && entry.id === paneId)
    : undefined
  return (isProviderRecord(pane) && nonemptyString(pane.plugin)) || paneId
}

export class ClaudePluginInputError extends Error {
  readonly failure: SubmissionRejectionFact

  constructor(plugin: string) {
    const failure = agentSessionFailureFact('pluginInputRequired', {
      detail: providerDiagnostic(plugin, 'person')
    })
    super(agentSessionFailureSentence(failure, 'row', { agentName: 'Claude' }))
    this.failure = failure
  }
}
