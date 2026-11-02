import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { conversationWorkspace } from './project-conversations.test-fixture'
import { useConversationDetails } from './use-conversation-details'

it('drops details and ignores an old drawer selection after client, host or generation cutover', () => {
  const firstClient = {}
  let owner = { client: firstClient, hostId: 'first', generation: 1 }
  const observed: { current: ReturnType<typeof useConversationDetails> | null } = { current: null }
  const row = {
    key: 'chat',
    title: 'First host chat',
    agent: 'codex',
    status: 'saved' as const,
    at: 1,
    workspace: conversationWorkspace()
  }
  function Probe() {
    observed.current = useConversationDetails(owner)
    return null
  }
  let tree: ReactTestRenderer | undefined
  try {
    act(() => {
      tree = create(createElement(Probe))
    })
    for (const next of [
      { client: {}, hostId: 'first', generation: 1 },
      { client: firstClient, hostId: 'second', generation: 1 },
      { client: firstClient, hostId: 'first', generation: 2 }
    ]) {
      owner = { client: firstClient, hostId: 'first', generation: 1 }
      act(() => tree?.update(createElement(Probe)))
      const select = observed.current?.setDetails
      act(() => select?.(row))
      expect(observed.current?.details).toBe(row)
      owner = next
      act(() => tree?.update(createElement(Probe)))
      expect(observed.current?.details).toBeNull()
      const newRow = { ...row, key: 'new-owner-chat' }
      act(() => observed.current?.setDetails(newRow))
      act(() => select?.(row))
      expect(observed.current?.details).toBe(newRow)
    }
  } finally {
    act(() => tree?.unmount())
  }
})
