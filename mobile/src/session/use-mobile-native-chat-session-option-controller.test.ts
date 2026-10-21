import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'

describe('useMobileNativeChatSessionOptionController on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it("keeps the chat's /clear and /compact when its agent lists no models", () => {
    const seen: { current: ReturnType<typeof useMobileNativeChatSessionOptionController> | null } =
      { current: null }
    function Harness(): null {
      seen.current = useMobileNativeChatSessionOptionController({
        activeChatStructured: true,
        activeSessionTabId: 'omp-tab',
        agent: 'omp',
        dispatchCommand: vi.fn(),
        hostId: 'host',
        isTabChatView: () => true,
        isWorking: false,
        reportedModel: null,
        // OMP's options read answers with no model list, so there is nothing to pick.
        structured: {
          conversationCommands: ['clear', 'compact'],
          snapshot: [],
          pendingId: null,
          setOption: vi.fn(),
          invokeAction: vi.fn()
        },
        toggleTabChatView: vi.fn(),
        worktreeId: 'worktree'
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(seen.current?.nativeChatSessionOptions?.controller.conversationCommands).toEqual([
      'clear',
      'compact'
    ])
  })
})
