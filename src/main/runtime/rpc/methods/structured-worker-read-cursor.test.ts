import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
/** Mutate journals between reads to catch in-place revisions and mid-array insertions missed by oldest-item-only cursor identity; both can silently omit or duplicate output. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerJournal } = await import('./orchestration-structured-worker-lifecycle')

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

function message(itemId: string, text: string, revision = 1): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: Number(itemId.slice(1)),
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  } as unknown as AgentJournalRenderItem
}

/** Projects to null while pending, and to a system message once resolved — mid-array. */
function approval(itemId: string, resolved: boolean, revision = 1): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: Number(itemId.slice(1)),
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'run it?',
      detail: null,
      resolution: { state: resolved ? 'approved' : 'pending' }
    }
  } as unknown as AgentJournalRenderItem
}

function installJournal(items: AgentJournalRenderItem[]): void {
  hostRef.current = {
    deps: {
      store: {
        getConversation: () =>
          agentSessionConversationView(
            agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: IDENTITY.sessionId }))
          )
      }
    },
    hasSession: () => true,
    history: () => ({ page: { items, hasOlder: false } })
  }
}

function read(cursor?: string, limit?: number) {
  return readStructuredWorkerJournal({
    identity: IDENTITY,
    dispatchId: 'd1',
    workerState: 'ready',
    liveness: 'live',
    agent: 'claude',
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit })
  })
}

function textsOf(result: Awaited<ReturnType<typeof read>>): string[] {
  return result.transcript.messages.map((entry) =>
    entry.blocks.map((block) => ('text' in block ? block.text : '')).join('')
  )
}

describe('the structured worker-read cursor over a mutating journal', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('refuses to resume when an already-delivered item was revised in place', async () => {
    // Revise an already-read item in place; old oldest-item identity silently skipped the revised text.
    installJournal([message('i1', 'hel'), message('i2', 'second')])
    const first = await read(undefined, 1)
    expect(textsOf(first)).toEqual(['hel'])

    installJournal([message('i1', 'hello world', 2), message('i2', 'second')])
    await expect(read(first.cursor)).rejects.toThrow(/source changed/i)
  })

  it('refuses to resume when a resolved prompt inserts ahead of the caller position', async () => {
    // Resolving an approval inserts a message mid-array; the old cursor accepted a stale index and duplicated content.
    installJournal([message('i1', 'first'), approval('i2', false), message('i3', 'second')])
    const first = await read(undefined, 2)
    expect(textsOf(first)).toEqual(['first', 'second'])

    installJournal([message('i1', 'first'), approval('i2', true, 2), message('i3', 'second')])
    await expect(read(first.cursor)).rejects.toThrow(/source changed/i)
  })

  it('still resumes across a page boundary when only unread tail items change', async () => {
    // Hash only consumed prefix: whole-page hashing would invalidate on every streaming revision (~60ms).
    installJournal([message('i1', 'first'), message('i2', 'streaming')])
    const first = await read(undefined, 1)
    expect(textsOf(first)).toEqual(['first'])

    installJournal([message('i1', 'first'), message('i2', 'streaming more', 7)])
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['streaming more'])
  })

  it('delivers every message exactly once when nothing below the cursor changes', async () => {
    installJournal([message('i1', 'a'), message('i2', 'b'), message('i3', 'c')])
    const first = await read(undefined, 2)
    const second = await read(first.cursor, 2)
    expect([...textsOf(first), ...textsOf(second)]).toEqual(['a', 'b', 'c'])
  })

  it('still refuses when the window slides off the front', async () => {
    // Keep detecting window slides, which shift every message index.
    installJournal([message('i1', 'a'), message('i2', 'b')])
    const first = await read(undefined, 1)
    installJournal([message('i2', 'b'), message('i3', 'c')])
    await expect(read(first.cursor)).rejects.toThrow(/source changed/i)
  })
})
