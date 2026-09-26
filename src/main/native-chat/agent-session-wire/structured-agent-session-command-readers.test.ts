// After `/compact`, every reader that reports on the user's requests reads past the command: the
// sidebar's prompt, preview, verdict and instant, restart resume, and an older client's label.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import { projectTurnItemHistory } from '../../runtime/rpc/methods/structured-agent-session-turn-item-capability'
import { structuredAgentSessionWorkingAtStop } from './structured-agent-session-working-at-teardown'
import {
  journal,
  NOW,
  record,
  SESSION,
  TEARDOWN_CURRENT
} from './structured-agent-session-restart-resume-test-harness'

const PROMPT = agentJournalSubmissionKey('prompt-1')
const COMMAND = agentJournalSubmissionKey('command-1')
const REAL_TURN = 'legacy:codex:session:turn-lifecycle%3Aturn-1'
const COMMAND_TURN = 'orca:command-turn%3Acommand-1'

let sequence = 0
function item(itemId: string, body: AgentJournalRenderItem['body'], scope?: string) {
  sequence += 1
  return {
    itemId,
    revision: 1,
    body,
    sequence,
    observedAt: NOW,
    turnScope: scope ? { kind: 'turn' as const, turnItemId: scope } : { kind: 'thread' as const }
  }
}

function accepted(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: NOW,
    resolvedAt: NOW
  }
}

/** "List three fruits", answered, then `/compact` in its own turn. */
function compactedAfterARealTurn(commandState: 'running' | 'completed' = 'completed') {
  sequence = 0
  const items: AgentJournalRenderItem[] = [
    item(PROMPT, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'List three fruits' }]
    }),
    item(REAL_TURN, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'success',
      userItemId: PROMPT,
      startedAt: NOW,
      completedAt: NOW + 1_000
    }),
    item(
      'codex:answer',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Apple, pear, fig' }] },
      REAL_TURN
    ),
    item(COMMAND, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '/compact' }],
      command: { name: 'compact' }
    }),
    item(COMMAND_TURN, {
      kind: 'turn',
      turnId: 'compact:command-1',
      state: commandState,
      userItemId: COMMAND,
      startedAt: NOW + 5_000,
      ...(commandState === 'completed' ? { outcome: 'success', completedAt: NOW + 9_000 } : {})
    }),
    item(
      'codex:summary',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Summary of it all' }] },
      COMMAND_TURN
    ),
    item(
      'orca:command-result%3Acommand-1',
      { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' },
      COMMAND_TURN
    )
  ]
  return { items, submissions: [accepted('prompt-1'), accepted('command-1')] }
}

describe('the sidebar after /compact (B7)', () => {
  it('keeps the last real prompt, its answer, its verdict and its instant', () => {
    const { items, submissions } = compactedAfterARealTurn()
    expect(projectStructuredAgentSessionStatusSummary(items, submissions)).toEqual({
      status: 'idle',
      latestPrompt: 'List three fruits',
      lastAssistantMessage: 'Apple, pear, fig',
      turnOutcome: 'success',
      statusStartedAt: NOW + 1_000
    })
  })

  it('reads working while the command runs', () => {
    const { items, submissions } = compactedAfterARealTurn('running')
    expect(projectStructuredAgentSessionStatusSummary(items, submissions)).toMatchObject({
      status: 'working',
      latestPrompt: 'List three fruits'
    })
  })
})

describe('restart resume around /compact (B14)', () => {
  function markerFor(items: AgentJournalRenderItem[], tasks: boolean) {
    return structuredAgentSessionWorkingAtStop({
      sessionId: SESSION,
      session: { journal: journal(items), child: { fence: 1 } },
      getRecord: () => record(),
      backgroundTasks: () =>
        tasks ? [{ id: 'task-a', kind: 'agent', description: 'Review', state: 'working' }] : [],
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })
  }

  it('records nothing while the command runs', () => {
    expect(markerFor(compactedAfterARealTurn('running').items, false)).toBeNull()
  })

  it('anchors a settled lead with live children on its last real turn', () => {
    const marker = markerFor(compactedAfterARealTurn().items, true)
    expect(marker?.work).toEqual({ kind: 'turn', id: 'turn-1' })
    // The newest user message is still the last real prompt, as before commands were messages.
    expect(marker?.latestUserItemId).toBe(PROMPT)
  })
})

describe("an older client's label for a command turn (B17)", () => {
  it("names the session's agent, not the one its key suggests", () => {
    const { items, submissions } = compactedAfterARealTurn()
    const history = {
      ok: true as const,
      page: {
        sessionId: SESSION,
        epoch: 'epoch-1',
        direction: 'tail' as const,
        items,
        removedItemIds: [],
        submissions,
        window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
        hasOlder: false,
        hasNewer: false
      }
    }
    const projected = projectTurnItemHistory(history, { clientKind: 'runtime' }, 'claude')
    const commandTurn = projected.page.items.find((entry) => entry.itemId === COMMAND_TURN)
    expect(commandTurn?.body).toMatchObject({
      kind: 'status',
      text: expect.stringContaining('Claude')
    })
  })
})
