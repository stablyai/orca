import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { JournalItemRow } from '../../native-chat/agent-session-journal/durable-rows/journal-row-schema'

/** An open PR; the fields a watch reads come from `fields`. */
export function prInfoFixture(fields: Partial<PRInfo> & Pick<PRInfo, 'number'>): PRInfo {
  return {
    title: 'PR',
    state: 'open',
    url: `https://github.com/acme/repo/pull/${fields.number}`,
    checksStatus: 'pending',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    ...fields
  }
}

/** A finished shell call committed as a live journal item row. */
export function shellCallRow(itemId: string, command: string, output: string): JournalItemRow {
  const body: AgentJournalItemBody = {
    kind: 'tool-call',
    name: 'shell',
    input: { command },
    state: 'completed',
    output: { head: output, byteLength: output.length, digest: 'd', truncated: false }
  }
  return {
    v: 1,
    epoch: 'epoch-1',
    seq: 1,
    fence: 0,
    ts: 0,
    kind: 'item',
    itemId,
    revision: 2,
    body
  }
}
