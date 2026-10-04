import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'

export function dshAcpPromptContent(body: AgentJournalMessageItem): Record<string, unknown>[] {
  if (
    body.role !== 'user' ||
    body.blocks.length === 0 ||
    body.blocks.some((block) => block.type !== 'text')
  ) {
    throw new Error('The official DeepSeek Harness route accepts text prompts only')
  }
  return body.blocks.flatMap((block) =>
    block.type === 'text' ? [{ type: 'text', text: block.text }] : []
  )
}
export function dshDispatchRejection(
  failure: Parameters<typeof agentSessionFailureWords>[0]
): Omit<Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>, 'state'> {
  return agentSessionFailureWords(failure, { surface: 'rejection', agentName: 'DeepSeek Harness' })
}
export function dshPromptContentRejection(_error: unknown) {
  return dshDispatchRejection(agentSessionFailureFact('providerRejected'))
}
