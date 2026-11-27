import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isSubagentBlock } from '../../../../shared/native-chat/native-chat-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  StructuredAgentSessionSubagentRows,
  type AgentChildWorkRowView
} from './structured-agent-session-subagent-rows'

const SESSION = 'session-1'

function child(
  providerId: string,
  residency: AgentChildWorkRowView['residency'],
  parentChildWorkId?: string
): AgentChildWorkRowView {
  return {
    id: `child-${providerId}`,
    providerId,
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: false,
    invocation: { invocationId: `run-${providerId}`, generation: 1 },
    residency,
    ...(parentChildWorkId ? { parentChildWorkId } : {})
  }
}

async function groupsOf(children: AgentChildWorkRowView[]): Promise<Record<string, string>> {
  const groups: Record<string, string> = {}
  const journal = {
    reads: { historyItems: async () => [] },
    appendItem: async (_identity: unknown, body: AgentJournalItemBody) => {
      for (const block of body.kind === 'message' ? body.blocks : []) {
        if (isSubagentBlock(block)) {
          groups[block.id] = block.groupId
        }
      }
    }
  }
  const rows = new StructuredAgentSessionSubagentRows({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read saved items and append new ones; the fake implements exactly those two calls.
    journal: () => journal as unknown as AgentSessionJournal,
    fence: () => 1,
    currentWork: async () => ({ turnScope: () => AGENT_JOURNAL_THREAD_SCOPE }),
    readChildWork: () => children,
    onWriteFailed: (_sessionId, error) => {
      throw error
    }
  })
  rows.changed(SESSION)
  await rows.drain(SESSION)
  return groups
}

describe('StructuredAgentSessionSubagentRows grouping', () => {
  it('gives each turnless foreground child its own group and keeps background ones together', async () => {
    const groups = await groupsOf([
      child('fork-1', 'foreground'),
      child('fork-2', 'foreground'),
      child('helper', 'foreground', 'child-fork-2'),
      child('bg-1', 'background'),
      child('bg-2', 'background')
    ])

    expect(groups).toEqual({
      'fork-1': 'fork-1',
      'fork-2': 'fork-2',
      helper: 'fork-2',
      'bg-1': 'thread',
      'bg-2': 'thread'
    })
  })
})
