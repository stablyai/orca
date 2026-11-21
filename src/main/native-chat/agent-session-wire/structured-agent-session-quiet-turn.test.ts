import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { agentSessionAttentionNews } from '../../../shared/agent-session/view/agent-session-attention'
import { StructuredAgentSessionTurnCompletionFeed } from './observations/structured-agent-session-turn-completion-feed'
import { readHostStatusState } from './structured-agent-session-host-status.test-fixture'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder:scout-home',
  workspaceKind: 'folder'
} as const

function item(itemId: string, sequence: number, body: AgentJournalRenderItem['body']) {
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body
  } satisfies AgentJournalRenderItem
}

/** A bot run's turn: the prompt, the turn's lifecycle, then the agent's last words. */
function run(
  state: 'running' | 'completed',
  lastWords: string,
  outcome: 'success' | 'failure' = 'success'
): AgentJournalRenderItem[] {
  return [
    item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Morning digest' }]
    }),
    item('turn', 2, {
      kind: 'status',
      text: state === 'running' ? 'Working' : 'Done',
      turnLifecycle:
        state === 'running' ? { turnId: 'turn-1', state } : { turnId: 'turn-1', state, outcome }
    }),
    item('said', 3, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: lastWords }]
    })
  ]
}

async function settle(lastWords: string): Promise<AgentSessionTurnCompletionEvent[]> {
  let items = run('running', lastWords)
  let cursor = { epoch: 'epoch-1', sequence: 1 }
  const sessions = new Map([
    ['run-1', { journal: { cursor: () => cursor }, params: { location: LOCATION } }]
  ])
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    readChildWork: () => undefined,
    now: () => 1_700,
    readStatusState: async () => readHostStatusState(items)
  })
  const events: AgentSessionTurnCompletionEvent[] = []
  feed.subscribe({ id: 'sub', emit: (event) => events.push(event) })
  await feed.observe('run-1')
  items = run('completed', lastWords)
  cursor = { epoch: 'epoch-1', sequence: 2 }
  await feed.observe('run-1')
  return events
}

describe('a bot turn that ends on its quiet marker', () => {
  it('still reports the turn end, marked quiet, and carries no attention news', async () => {
    const [event] = await settle(
      `${'Looked through every open PR and thread. '.repeat(20)}\n\nNO_REPLY`
    )
    expect(event).toMatchObject({
      type: 'completion',
      completion: { outcome: 'success', quiet: true }
    })
    if (event?.type !== 'completion') {
      throw new Error('no completion')
    }
    // No push, banner or unread, whatever the bot's Task Complete switch says.
    expect(agentSessionAttentionNews(event)).toBeNull()
  })

  it('leaves a turn with something to say as ordinary news', async () => {
    const [event] = await settle('Two PRs need your review: #1234 and #1229.')
    expect(event).toMatchObject({ type: 'completion', completion: { outcome: 'success' } })
    expect(event?.type === 'completion' && event.completion.quiet).toBeFalsy()
    if (event?.type !== 'completion') {
      throw new Error('no completion')
    }
    expect(agentSessionAttentionNews(event)).toEqual({ agentState: 'done', outcome: 'success' })
  })

  it('reads a failure its host keeps quiet as no news, and still alerts while waiting on the owner', () => {
    const completion = {
      scope: LOCATION,
      sessionId: 'run-1',
      turnId: 'turn-1',
      completedAt: 1,
      quiet: true as const
    }
    expect(
      agentSessionAttentionNews({
        type: 'completion',
        completion: { ...completion, outcome: 'failure' }
      })
    ).toBeNull()
    expect(
      agentSessionAttentionNews({
        type: 'completion',
        completion: { ...completion, outcome: 'success', awaitingUser: true }
      })
    ).toEqual({ agentState: 'blocked', outcome: 'success' })
  })
})

describe('a failed turn', () => {
  it('is quiet only where its host keeps a repeat failure quiet, never for its quiet marker', () => {
    const items = run('completed', 'NO_REPLY', 'failure')
    expect(readHostStatusState(items).quiet).toBeUndefined()
    expect(readHostStatusState(items, [], (outcome) => outcome === 'failure').quiet).toBe(true)
  })
})

describe('a turn its host keeps quiet', () => {
  it('is quiet when it succeeds without the marker, or with the marker not its last word', () => {
    for (const lastWords of [
      'Found 3 things worth your time.',
      'NO_REPLY, except CI on main is red.'
    ]) {
      const items = run('completed', lastWords)
      expect(readHostStatusState(items).quiet).toBeUndefined()
      expect(readHostStatusState(items, [], (outcome) => outcome === 'success').quiet).toBe(true)
    }
  })
})
