import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>

const ask: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'debug on what went wrong' }],
  timestamp: 1_000,
  source: 'transcript'
}
const reply: NativeChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Looking into it.' }],
  timestamp: 2_000,
  source: 'transcript'
}

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function disclose(messages: NativeChatMessage[], activityText: string | null): Disclosure {
  let latest: Disclosure | null = null
  function Probe(): null {
    latest = useMobileNativeChatTurnDisclosure({
      messages,
      enabled: true,
      isWorking: true,
      workingStartedAt: 1_000,
      settledTurns: null,
      activityText,
      scopeKey: 'chat'
    })
    return null
  }
  act(() => {
    tree = create(createElement(Probe))
  })
  return latest!
}

function barRow(turns: Disclosure) {
  const index = turns.listMessages.findIndex((message) => message.id === ask.id)
  return turns.resolveRow(index, ask)
}

it('drops the bare "Working…" line right under the live bar, which spins in its place', () => {
  const turns = disclose([ask], null)

  expect(turns.liveLine).toBeNull()
  expect(barRow(turns).turnStatus).not.toBeNull()
  expect(barRow(turns).turnStatusLive).toBe(true)
})

it('keeps a real step under the live bar, across its line', () => {
  const turns = disclose([ask], 'Reading 3 files')

  expect(turns.liveLine).toMatchObject({ activityText: 'Reading 3 files', underTurnBar: true })
  expect(barRow(turns).turnStatusLive).toBeUndefined()
})

it('keeps the bare line when the turn has rows between it and the bar', () => {
  const turns = disclose([ask, reply], null)

  expect(turns.liveLine).toMatchObject({ activityText: null, underTurnBar: false })
  expect(barRow(turns).turnStatusLive).toBeUndefined()
})
