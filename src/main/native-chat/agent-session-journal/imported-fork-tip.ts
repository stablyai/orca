import { asRecord, parseJsonObject } from '../../ai-vault/session-scanner-values'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** Provider terminal proof belongs to the latest imported root, never to prose or a lease. */
export function createImportedForkTip() {
  let items: string[] = []
  let settled = false
  return {
    observe(id: string, role: string, terminal: boolean) {
      if (role === 'user') {
        items = []
        settled = false
      }
      items.push(id)
      if (role === 'assistant' || role === 'tool' || role === 'reasoning' || role === 'terminal') {
        settled = terminal
      }
    },
    settledItems: () => (settled ? items : [])
  }
}

export function observeOmpForkTip(
  tip: ReturnType<typeof createImportedForkTip>,
  line: string,
  identity: AgentJournalItemIdentity
): void {
  const raw = parseJsonObject(line)
  const native = asRecord(raw?.message)
  const role = native?.role
  if (
    raw?.type === 'message' &&
    (role === 'user' || role === 'assistant' || role === 'toolResult')
  ) {
    tip.observe(
      agentJournalItemKey(identity),
      role === 'toolResult' ? 'tool' : role,
      role === 'assistant' &&
        ['stop', 'length', 'aborted', 'error'].includes(String(native?.stopReason))
    )
  }
}
