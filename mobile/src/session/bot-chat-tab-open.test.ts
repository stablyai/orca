import { describe, expect, it, vi } from 'vitest'
import { openBotChatTab, type BotChatTabScope } from './bot-chat-tab-open'

// After a /clear, Home Chat's tab runs a newer session than the chat id an item note names.
const homeTab = { id: 'tab-home', type: 'agent-session', sessionId: 'home-live' }

function scope(active = 'tab-other') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener reads only these.
  return {
    homeChatId: 'home-live',
    sessionTabs: [homeTab],
    activeSessionTabId: active,
    switchSessionTab: vi.fn(),
    openNativeSession: vi.fn(async () => {}),
    worktreeId: 'folder:bot'
  } as unknown as BotChatTabScope & {
    switchSessionTab: ReturnType<typeof vi.fn>
    openNativeSession: ReturnType<typeof vi.fn>
  }
}

describe('opening a bot chat from the chat screen', () => {
  it("switches to Home Chat's live tab, not a history tab of its chat id", () => {
    const s = scope()
    openBotChatTab({ chatId: 'home-root', home: true }, s)
    expect(s.switchSessionTab).toHaveBeenCalledWith(homeTab)
    expect(s.openNativeSession).not.toHaveBeenCalled()
  })

  it('opens any other chat as its tab', () => {
    const s = scope()
    openBotChatTab({ chatId: 'chat-a', home: false }, s)
    expect(s.switchSessionTab).not.toHaveBeenCalled()
    expect(s.openNativeSession).toHaveBeenCalledWith({
      kind: 'history',
      structuredSession: { sessionId: 'chat-a', workspaceId: 'folder:bot' }
    })
  })
})
