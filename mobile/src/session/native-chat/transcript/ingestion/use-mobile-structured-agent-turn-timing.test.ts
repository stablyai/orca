import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { noteStreamedTextRevision } from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'

const reply = (text: string): AgentJournalRenderItem => ({
  itemId: 'reply',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

it("keeps the turn journal while only a streaming reply's text grows", () => {
  const journals: NativeChatTurnJournal[] = []
  const submissions: never[] = []
  let items: readonly AgentJournalRenderItem[] = [reply('The reply')]
  function Reader(): null {
    journals.push(useMobileStructuredAgentTurnTiming({ items, submissions }, null).turnJournal)
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(createElement(Reader))
  })
  const grown = [reply('The reply, and more of it')]
  noteStreamedTextRevision(grown, items)
  items = grown
  act(() => renderer?.update(createElement(Reader)))
  expect(journals.length).toBeGreaterThan(1)
  expect(journals.at(-1)).toBe(journals[0])
})
