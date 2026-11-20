import { afterEach, describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeRuntimeStoreWithWorkspaceSession } from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { placeBotHomeInSnapshot } from './bot-home-snapshot'
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
        ['left', [REOPENED_HOME, 'agent-session:side']]
      ])
      expect(stored.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'left' })
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

  it('hands focus on a dropped duplicate to Home in its own group, keeping each group on its own tabs', () => {
    const placed = placeBotHomeInSnapshot(
      {
        ...savedPage(),
        activeGroupId: 'right',
        activeTabId: 'agent-session:home',
        tabGroups: [
          {
            id: 'left',
            activeTabId: 'agent-session:side',
            tabOrder: [REOPENED_HOME, 'agent-session:side']
          },
          {
            id: 'right',
            activeTabId: 'agent-session:home',
            tabOrder: ['agent-session:home', 'agent-session:other']
          }
        ],
        tabs: [...savedPage().tabs, chat('agent-session:other', 'other')]
      },
      'home',
      REOPENED_HOME
    )
    expect(placed.activeGroupId).toBe('left')
    expect(placed.activeTabId).toBe(REOPENED_HOME)
    expect(placed.tabGroups?.map((group) => [group.id, group.activeTabId])).toEqual([
      ['left', REOPENED_HOME],
      ['right', 'agent-session:other']
    ])
  })
  it('publishes Home first after a client drags a side chat ahead of it', async () => {
    const { runtime } = windowlessServer()
    runtime.storeMobileSessionSnapshot(PAGE, {
      ...savedPage(),
      activeGroupId: 'left',
      tabGroups: [
        {
          id: 'left',
          activeTabId: 'agent-session:home',
          tabOrder: ['agent-session:home', 'agent-session:side']
        }
      ],
      tabGroupLayout: { type: 'leaf', groupId: 'left' },
      tabs: savedPage().tabs.filter((tab) => tab.id !== REOPENED_HOME)
    })
    const published: string[][] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged(
      (frame) => {
        if (frame.worktree === PAGE) {
          published.push(frame.tabGroups?.[0]?.tabOrder ?? [])
        }
      },
      undefined,
      'mobile'
    )
    try {
      await runtime.moveMobileSessionTab(`id:${PAGE}`, {
        kind: 'reorder',
        tabId: 'agent-session:side',
        targetGroupId: 'left',
        tabOrder: ['agent-session:side', 'agent-session:home']
      })
    } finally {
      unsubscribe()
    }
    expect(published.at(-1)).toEqual(['agent-session:home', 'agent-session:side'])
  })

  it('splits a side chat to the left without publishing the group Home left behind', async () => {
    const { runtime } = windowlessServer()
    runtime.storeMobileSessionSnapshot(PAGE, {
      ...savedPage(),
      activeGroupId: 'only',
      tabGroups: [
        {
          id: 'only',
          activeTabId: 'agent-session:home',
          tabOrder: ['agent-session:home', 'agent-session:side']
        }
      ],
      tabGroupLayout: { type: 'leaf', groupId: 'only' },
      tabs: savedPage().tabs.filter((tab) => tab.id !== REOPENED_HOME)
    })
    const published: RuntimeMobileSessionTabsSnapshot[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged(
      (frame) => {
        if (frame.worktree === PAGE) {
          published.push(frame)
        }
      },
      undefined,
      'mobile'
    )
    try {
      await runtime.moveMobileSessionTab(`id:${PAGE}`, {
        kind: 'split',
        tabId: 'agent-session:side',
        targetGroupId: 'only',
        splitDirection: 'left'
      })
    } finally {
      unsubscribe()
    }
    const frame = published.at(-1)
    const [group] = frame?.tabGroups ?? []
    expect(frame?.tabGroups).toHaveLength(1)
    expect(group?.tabOrder).toEqual(['agent-session:home', 'agent-session:side'])
    expect(frame?.tabGroupLayout).toEqual({ type: 'leaf', groupId: group?.id })
    expect(frame?.activeGroupId).toBe(group?.id)
    // The dragged side chat keeps focus; Home's stale top-level selection does not reclaim it.
    expect(group?.activeTabId).toBe('agent-session:side')
    expect(frame?.activeTabId).toBe('agent-session:side')
    expect(runtime.mobileSessionTabsByWorktree.get(PAGE)?.tabGroups).toHaveLength(1)
  })
})

describe('storing a page on a runtime with no desktop window API', () => {
  it('stores a plain page and a bot page as orcad does when a terminal opens', () => {
    const { runtime } = windowlessServer()
    // orcad's runtime is this shape: no window accessor beyond the id-based authority checks.
    expect('getAvailableAuthoritativeWindow' in runtime).toBe(false)
    const plain = runtime.storeMobileSessionSnapshot('folder:plain', {
      ...savedPage(),
      worktree: 'folder:plain'
    })
    expect(plain.tabGroups?.map((group) => group.tabOrder)).toEqual(
      savedPage().tabGroups?.map((group) => group.tabOrder)
    )
    // With no chat host to name the current Home tab, the first Home row is kept and placed first.
    const page = runtime.storeMobileSessionSnapshot(PAGE, savedPage())
    expect(page.tabGroups?.map((group) => group.tabOrder)).toEqual([
      [REOPENED_HOME, 'agent-session:side']
    ])
  })
})
