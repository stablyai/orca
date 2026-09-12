/**
 * The structured `worker-read --source transcript` cursor across a MUTATING journal.
 *
 * The journal is a reduced, mutable timeline, and the old `source_changed` anchor fingerprinted
 * only the oldest item's id. It fired when the window slid off the front and could not fire when
 * the page's contents changed under a stable oldest item — the normal case. Two silent failures
 * followed, both returning ok: an already-delivered item revised in place was never redelivered
 * (omission), and a pending approval resolving into the MIDDLE of the array shifted the caller's
 * saved index back onto content it already had (duplication).
 *
 * A static-journal test passes either way, so every case here mutates between reads.
 */

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
    deps: { store: { getRecord: () => null } },
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

function textsOf(result: ReturnType<typeof read>): string[] {
  return result.transcript.messages.map((entry) =>
    entry.blocks.map((block) => ('text' in block ? block.text : '')).join('')
  )
}

describe('the structured worker-read cursor over a mutating journal', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('refuses to resume when an already-delivered item was revised in place', () => {
    // The `"hel"` / `"hello"` defect. The caller is handed a coalesced snapshot, resumes past it,
    // and the item is later revised at its original sequence — under the old anchor the resume was
    // accepted and that revision was never delivered to anyone.
    installJournal([message('i1', 'hel'), message('i2', 'second')])
    const first = read(undefined, 1)
    expect(textsOf(first)).toEqual(['hel'])

    installJournal([message('i1', 'hello world', 2), message('i2', 'second')])
    expect(() => read(first.cursor)).toThrow(/source changed/i)
  })

  it('refuses to resume when a resolved prompt inserts ahead of the caller position', () => {
    // Duplication. A pending approval projects to null, so resolving it inserts a message in the
    // MIDDLE; the oldest item never moved, so the old anchor accepted a now-stale index and the
    // caller re-read content it already had.
    installJournal([message('i1', 'first'), approval('i2', false), message('i3', 'second')])
    const first = read(undefined, 2)
    expect(textsOf(first)).toEqual(['first', 'second'])

    installJournal([message('i1', 'first'), approval('i2', true, 2), message('i3', 'second')])
    expect(() => read(first.cursor)).toThrow(/source changed/i)
  })

  it('still resumes across a page boundary when only unread tail items change', () => {
    // The reason this is prefix-scoped and not whole-page: during an active turn the coalescer
    // revises the streaming item every 60ms. Fingerprinting the whole page would invalidate the
    // cursor continuously — a useless verb — while the worker is working.
    installJournal([message('i1', 'first'), message('i2', 'streaming')])
    const first = read(undefined, 1)
    expect(textsOf(first)).toEqual(['first'])

    installJournal([message('i1', 'first'), message('i2', 'streaming more', 7)])
    const second = read(first.cursor)
    expect(textsOf(second)).toEqual(['streaming more'])
  })

  it('delivers every message exactly once when nothing below the cursor changes', () => {
    // The property the two refusals above protect: no omission, no duplication.
    installJournal([message('i1', 'a'), message('i2', 'b'), message('i3', 'c')])
    const first = read(undefined, 2)
    const second = read(first.cursor, 2)
    expect([...textsOf(first), ...textsOf(second)]).toEqual(['a', 'b', 'c'])
  })

  it('still refuses when the window slides off the front', () => {
    // The case the old anchor DID catch, and which the prefix scoping must not lose: a slide
    // shifts every index.
    installJournal([message('i1', 'a'), message('i2', 'b')])
    const first = read(undefined, 1)
    installJournal([message('i2', 'b'), message('i3', 'c')])
    expect(() => read(first.cursor)).toThrow(/source changed/i)
  })
})
