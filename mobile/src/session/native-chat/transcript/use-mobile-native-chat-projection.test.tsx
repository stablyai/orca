import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { useMobileNativeChatProjection } from './use-mobile-native-chat-projection'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const CI_ID = 'orca:pr-event:github.com/acme/repo#3:8d5f74b:1'
let roleReads = 0

// The CI predicate reads `role` first, so a counting getter sees every row it checks.
function counted(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  const message = { id, blocks: [{ type: 'text', text }], source: 'transcript', timestamp: 0 }
  Object.defineProperty(message, 'role', {
    enumerable: true,
    get: () => {
      roleReads++
      return role
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `role` is defined above as a getter.
  return message as NativeChatMessage
}

const conversation = (turns: number) =>
  Array.from({ length: turns }, (_, index) => [
    counted(`u${index}`, 'user', `ask ${index}`),
    counted(`a${index}`, 'assistant', `answer ${index}`)
  ]).flat()

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  act(() => renderers.forEach((renderer) => renderer.unmount()))
  renderers.length = 0
})

function mount(messages: readonly NativeChatMessage[], shows: boolean) {
  const view: { rows: NativeChatMessage[] } = { rows: [] }
  function Probe(props: { messages: readonly NativeChatMessage[]; shows: boolean }) {
    view.rows = useMobileNativeChatProjection(props.messages, 'claude', ['chat'], props.shows)
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(<Probe messages={messages} shows={shows} />)
  })
  renderers.push(renderer)
  const update = (next: readonly NativeChatMessage[], nextShows: boolean): number => {
    roleReads = 0
    act(() => renderer.update(<Probe messages={next} shows={nextShows} />))
    return roleReads
  }
  return { view, update }
}

it('hides CI result lines after projection, one predicate pass per changed row array', () => {
  for (const turns of [25, 250]) {
    const history = conversation(turns)
    const appended = [...history, counted('tail', 'assistant', 'streamed')]
    const shown = mount(history, true)
    const projectionReads = shown.update(appended, true)
    const hidden = mount(history, false)
    // Hidden adds one read per projected row: the filter checks each row once.
    expect(hidden.update(appended, false) - projectionReads).toBe(turns * 2 + 1)
    const hiddenRows = hidden.view.rows
    expect(hidden.update(appended, false)).toBe(0)
    // With no CI row the filter hands back the projection itself, and a flip rebuilds nothing.
    expect(hidden.update(appended, true)).toBe(0)
    expect(hidden.view.rows).toBe(hiddenRows)
  }

  const ciLine: NativeChatMessage = {
    id: CI_ID,
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: 'CI failing on repo#3 at 8d5f74b',
        presentation: 'pull-request-event',
        tone: 'failure'
      }
    ],
    timestamp: 0,
    source: 'transcript'
  }
  const withCi = [
    counted('u1', 'user', 'open a PR'),
    counted('a1', 'assistant', 'Opened it'),
    ciLine,
    counted('a2', 'assistant', 'Pushed the fix')
  ]
  const chat = mount(withCi, true)
  const shownRows = chat.view.rows
  expect(shownRows.map((row) => row.id)).toEqual(['u1', 'a1', CI_ID, 'a2'])
  chat.update(withCi, false)
  expect(chat.view.rows.map((row) => row.id)).toEqual(['u1', 'a1', 'a2'])
  chat.update(withCi, true)
  expect(chat.view.rows).toBe(shownRows)
})
