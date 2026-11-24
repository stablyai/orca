import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AcpSessionEvent } from '../../../protocol/acp-session-events'
import type { AcpTimelineTranslator } from '../../../timeline/acp-timeline-translator'
import { AcpKeptRows } from '../acp-kept-rows'

type Update = Record<string, unknown>

function known(update: Update): AcpSessionEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only sessionUpdate, messageId, content and toolCallId.
  return { kind: 'known', notification: { sessionId: 'p1', update } } as unknown as AcpSessionEvent
}

const chunk = (messageId: string, text: string): AcpSessionEvent =>
  known({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })

function savedMessage(text: string): AgentJournalRenderItem {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only the saved row's body.
  return {
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  } as unknown as AgentJournalRenderItem
}

function textOf(event: AcpSessionEvent): string | null {
  const update = event.kind === 'known' ? event.notification.update : null
  return update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : null
}

describe('a kept agent continuing rows the earlier app saved', () => {
  it('continues a saved message once, in order, and reads nothing after its turn', async () => {
    const read = vi.fn(async () => savedMessage('Hello '))
    const seed = { providerSessionId: 'p1', carryTool: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate uses only the translator's session id and its saved-call seed.
    const translator = seed as unknown as AcpTimelineTranslator
    const rows = new AcpKeptRows({
      agent: 'opencode',
      sessionId: 'chat',
      translator: () => translator,
      read
    })
    const delivered: (string | null)[] = []
    const route = rows.route((event) => delivered.push(textOf(event)))

    route(chunk('m1', 'world'))
    route(chunk('m1', '!'))
    route(known({ sessionUpdate: 'plan', entries: [] }))
    await vi.waitFor(() => expect(delivered).toHaveLength(3))

    expect(delivered).toEqual(['Hello world', '!', null])
    expect(read).toHaveBeenCalledTimes(1)

    rows.end()
    route(chunk('m2', 'later'))
    expect(delivered.at(-1)).toBe('later')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('drops replayed chunks the saved text already holds, and is drained before an answer', async () => {
    const read = vi.fn(async () => savedMessage('Hello brave new world, how '))
    const seed = { providerSessionId: 'p1', carryTool: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate uses only the translator's session id and its saved-call seed.
    const translator = seed as unknown as AcpTimelineTranslator
    const rows = new AcpKeptRows({
      agent: 'opencode',
      sessionId: 'chat',
      translator: () => translator,
      read
    })
    const delivered: (string | null)[] = []
    const route = rows.route((event) => delivered.push(textOf(event)))

    // Saved and then quit before the ack: the replay repeats "brave new world, how ".
    route(chunk('m1', 'brave new '))
    route(chunk('m1', 'world, how '))
    route(chunk('m1', 'are you'))
    await rows.drained()

    expect(delivered).toEqual(['Hello brave new world, how ', 'are you'])
  })
})
