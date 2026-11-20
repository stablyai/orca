import { afterEach, describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeRuntimeStoreWithWorkspaceSession } from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

const PAGE = 'folder:bot-home'
const REOPENED_HOME = 'agent-chat-tab-v1-home'

function chat(id: string, sessionId: string, isPinned?: boolean) {
  return {
    type: 'agent-session' as const,
    id,
    title: 'Chat',
    sessionId,
    agent: 'claude' as const,
    isActive: false,
    ...(isPinned !== undefined ? { isPinned } : {})
  }
}

/** A windowless server's saved order: a pinned side chat, then a split holding Home. */
function savedPage(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: PAGE,
    publicationEpoch: 'headless',
    snapshotVersion: 1,
    activeGroupId: 'right',
    activeTabId: 'agent-session:home',
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'left', activeTabId: 'agent-session:side', tabOrder: ['agent-session:side'] },
      {
        id: 'right',
        activeTabId: 'agent-session:home',
        tabOrder: [REOPENED_HOME, 'agent-session:home']
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'left' },
      second: { type: 'leaf', groupId: 'right' }
    },
    tabs: [
      chat('agent-session:side', 'side', true),
      chat(REOPENED_HOME, 'home'),
      { ...chat('agent-session:home', 'home'), isActive: true }
    ]
  }
}

/** Holds only what placement may ask, which Home tab is current; retiring or closing would throw. */
function currentTabOnlyHost(): StructuredAgentSessionHost {
  const host = {
    getSessionTabId: (sessionId: string) => (sessionId === 'home' ? REOPENED_HOME : null),
    deps: { store: { getConversation: () => undefined } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement and identity reconciliation read only these two members; any other call fails the test.
  return host as unknown as StructuredAgentSessionHost
}

function windowlessServer(bot = { chatSessionId: 'home' }) {
  const fixture = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService(
    Object.assign(fixture.runtimeStore, {
      getBots: () => [makeTestBot({ folderWorkspaceId: 'bot-home', ...bot })]
    })
  )
  return { runtime, writes: () => fixture.runtimeStore.setWorkspaceSession.mock.calls.length }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe("a windowless paired server's bot page", () => {
  it('keeps one Home first and pinned across a restart, without retiring its other view or saving', async () => {
    setStructuredAgentSessionHost(currentTabOnlyHost())

    // The second server starts from the same saved page, as a restart's hydrate does.
    for (const _restart of [1, 2]) {
      const { runtime, writes } = windowlessServer()
      const stored = runtime.storeMobileSessionSnapshot(PAGE, savedPage())
      expect(stored.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
        ['left', [REOPENED_HOME, 'agent-session:side']],
        ['right', []]
      ])
      expect(stored.activeGroupId).toBe('left')
      expect(stored.activeTabId).toBe(REOPENED_HOME)

      const served = await runtime.listMobileSessionTabs(`id:${PAGE}`)
      expect(
        served.tabs.map((tab) => [tab.id, tab.type === 'agent-session' ? tab.isPinned : null])
      ).toEqual([
        [REOPENED_HOME, true],
        ['agent-session:side', false]
      ])

      const before = writes()
      runtime.storeMobileSessionSnapshot(PAGE, stored)
      expect(writes()).toBe(before)
    }
  })
  it('unpins a replaced Home for every client and refuses pins that break the rule', async () => {
    const bot = { chatSessionId: 'home' }
    const { runtime } = windowlessServer(bot)
    const page = {
      ...savedPage(),
      tabs: savedPage().tabs.filter((tab) => tab.id !== REOPENED_HOME)
    }
    runtime.storeMobileSessionSnapshot(PAGE, page)
    bot.chatSessionId = 'side'
    // Resetting Home publishes its chat, which stores the page again.
    runtime.storeMobileSessionSnapshot(PAGE, runtime.mobileSessionTabsByWorktree.get(PAGE) ?? page)

    const served = await runtime.listMobileSessionTabs(`id:${PAGE}`)
    expect(
      served.tabs.map((tab) => [tab.id, tab.type === 'agent-session' ? tab.isPinned : null])
    ).toEqual([
      ['agent-session:side', true],
      ['agent-session:home', false]
    ])
    await expect(
      runtime.setMobileSessionTabProps(`id:${PAGE}`, {
        tabId: 'agent-session:home',
        isPinned: true
      })
    ).rejects.toThrow("A bot's side chats can't be pinned")
    await expect(
      runtime.setMobileSessionTabProps(`id:${PAGE}`, {
        tabId: 'agent-session:side',
        isPinned: false
      })
    ).rejects.toThrow("A bot's Home chat stays pinned")
  })
})
