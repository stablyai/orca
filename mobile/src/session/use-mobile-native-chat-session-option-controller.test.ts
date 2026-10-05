import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => {
  const state: { onAgentPicker: (() => void) | null } = { onAgentPicker: null }
  return state
})

vi.mock('./use-mobile-omp-model-discovery', () => ({ useMobileOmpModelDiscovery: () => [] }))
vi.mock('./use-mobile-native-chat-session-options', () => ({
  useMobileNativeChatSessionOptions: (args: { onAgentPicker: () => void }) => {
    held.onAgentPicker = args.onAgentPicker
    return { snapshot: [], recordCommand: () => {} }
  }
}))

import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'

describe('the composer agent-picker command (R2-F3)', () => {
  let renderer: ReactTestRenderer | null = null

  it('asks for the terminal view by name, not a toggle', () => {
    const setTabChatView = vi.fn()
    function Probe(): null {
      useMobileNativeChatSessionOptionController({
        activeChatStructured: false,
        activeSessionTabId: 'P::A',
        agent: 'claude',
        dispatchCommand: async () => 'accepted',
        hostId: 'h',
        isTabChatView: () => true,
        isWorking: false,
        reportedModel: null,
        structured: {
          snapshot: [],
          pendingId: null,
          setOption: async () => false,
          invokeAction: async () => false
        },
        setTabChatView,
        worktreeId: 'w'
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => held.onAgentPicker?.())
    expect(setTabChatView).toHaveBeenCalledWith('P::A', 'terminal')
    act(() => renderer?.unmount())
  })
})
