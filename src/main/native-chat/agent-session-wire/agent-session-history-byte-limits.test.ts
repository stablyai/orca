import { describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { readAgentSessionHistory } from './agent-session-history-page'

import { fixture, body, item } from './agent-session-history-contract-test-fixture'

describe('history page byte ceiling', () => {
  // Several legal messages exceed the 4 MiB outbound cap.
  const LARGE_TEXT = 'x'.repeat(250 * 1024)

  async function appendLargeItems(count: number): Promise<void> {
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      await fixture.journal.appendItem(item(ordinal), body(`${ordinal}:${LARGE_TEXT}`), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }

  function pageOf(result: ReturnType<typeof readAgentSessionHistory>) {
    if (!result.ok) {
      throw new Error(`expected a page, got reset ${result.reset}`)
    }
    serializeRemoteRuntimePayload(result.page)
    return result.page
  }

  it('keeps a tail of legal large messages under the channel cap and still pages back to every item', async () => {
    await appendLargeItems(20)

    const tail = pageOf(
      readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'tail',
        limit: 40
      })
    )
    expect(tail.items.length).toBeGreaterThan(0)
    expect(tail.hasOlder).toBe(true)

    const seen = tail.items.map((entry) => entry.itemId)
    let cursor = tail.window.nextCursor
    let hasOlder = tail.hasOlder
    let guard = 0
    while (hasOlder) {
      guard += 1
      expect(guard).toBeLessThan(30)
      const page = pageOf(
        readAgentSessionHistory(fixture.journal, {
          sessionId: 'session-1',
          direction: 'before',
          cursor,
          limit: 40
        })
      )
      expect(page.items.length).toBeGreaterThan(0)
      seen.push(...page.items.map((entry) => entry.itemId))
      cursor = page.window.nextCursor
      hasOlder = page.hasOlder
    }
    expect(new Set(seen).size).toBe(20)
  })

  it('bounds a forward catch-up page by bytes and keeps replaying to the head', async () => {
    const start = { epoch: fixture.journal.epoch, sequence: 0 }
    await appendLargeItems(20)

    const first = pageOf(
      readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'after',
        cursor: start,
        limit: 40
      })
    )
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.hasNewer).toBe(true)

    const seen = first.items.map((entry) => entry.itemId)
    let cursor = first.window.nextCursor
    let hasNewer = first.hasNewer
    let guard = 0
    while (hasNewer) {
      guard += 1
      expect(guard).toBeLessThan(30)
      const page = pageOf(
        readAgentSessionHistory(fixture.journal, {
          sessionId: 'session-1',
          direction: 'after',
          cursor,
          limit: 40
        })
      )
      expect(page.items.length).toBeGreaterThan(0)
      seen.push(...page.items.map((entry) => entry.itemId))
      cursor = page.window.nextCursor
      hasNewer = page.hasNewer
    }
    expect(new Set(seen).size).toBe(20)
  })

  it('sends a single over-budget item shortened and marked, never replaced', async () => {
    await fixture.journal.appendItem(item(1), body(`1:${'y'.repeat(3 * 1024 * 1024)}`), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })

    const tail = pageOf(
      readAgentSessionHistory(fixture.journal, {
        sessionId: 'session-1',
        direction: 'tail',
        limit: 40
      })
    )
    expect(tail.items).toHaveLength(1)
    const sent = tail.items[0]
    const text =
      sent?.body.kind === 'message' && sent.body.blocks[0]?.type === 'text'
        ? sent.body.blocks[0].text
        : ''
    expect(sent?.shortened).toBe(true)
    expect(text.startsWith('1:yyy')).toBe(true)
    expect(text.length).toBeLessThan(3 * 1024 * 1024)
  })
})
