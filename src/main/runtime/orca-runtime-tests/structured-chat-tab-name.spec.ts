import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

const SESSION_ID = 'session-1'
const CHAT_TAB_ID = `agent-session:${SESSION_ID}`

function makeSessionWithChat() {
  return makeWorkspaceSessionWithHeadlessTerminal({
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        {
          id: `structured-agent-session-${SESSION_ID}`,
          entityId: SESSION_ID,
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          label: 'Codex Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  } as never)
}

/** What a paired client actually receives: the frames the session-tab subscription delivers. */
function subscribeClient(runtime: OrcaRuntimeService): {
  frames: RuntimeMobileSessionTabsResult[]
  chatTitle: () => string | undefined
} {
  const frames: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    frames.push(snapshot)
  })
  return {
    frames,
    chatTitle: () => {
      const tab = frames.at(-1)?.tabs.find((candidate) => candidate.id === CHAT_TAB_ID)
      return tab?.type === 'agent-session' ? tab.title : undefined
    }
  }
}

async function makeRuntimeWithPublishedChat() {
  const session = makeSessionWithChat()
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: TEST_WORKTREE_ID,
    sessionId: SESSION_ID,
    agent: 'codex',
    activate: true
  })
  return { runtime, getSession }
}

describe('structured chat tab name', () => {
  it('publishes a rename to a subscribed client and persists it', async () => {
    const { runtime, getSession } = await makeRuntimeWithPublishedChat()
    const client = subscribeClient(runtime)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: 'Release notes'
    })

    expect(client.frames.length).toBeGreaterThan(0)
    expect(client.chatTitle()).toBe('Release notes')
    expect(
      getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find((tab) => tab.entityId === SESSION_ID)
        ?.customLabel
    ).toBe('Release notes')
  })

  it('keeps the rename when the desktop renderer republishes the worktree', async () => {
    const { runtime } = await makeRuntimeWithPublishedChat()
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: 'Release notes'
    })
    subscribeClient(runtime)

    // The renderer owns terminals and never publishes the chat tab; the merge must keep it.
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:1',
          snapshotVersion: 99,
          activeGroupId: 'renderer-group',
          activeTabId: 'host-tab::pane:1',
          activeTabType: 'terminal',
          tabGroups: [{ id: 'renderer-group', activeTabId: 'host-tab', tabOrder: ['host-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'Persisted Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    const merged = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const chat = merged.tabs.find((tab) => tab.id === CHAT_TAB_ID)
    expect(chat?.type === 'agent-session' && chat.title).toBe('Release notes')
  })

  it('names a chat while a desktop window is attached, which the renderer never republishes', async () => {
    const { runtime, getSession } = await makeRuntimeWithPublishedChat()
    electronMocks.BrowserWindow.fromId.mockImplementation((windowId: number) =>
      windowId === TEST_WINDOW_ID ? ({ isDestroyed: () => false } as never) : null
    )
    runtime.attachWindow(TEST_WINDOW_ID)
    const client = subscribeClient(runtime)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: 'Release notes'
    })
    expect(client.chatTitle()).toBe('Release notes')

    // The gate still holds for a renderer-owned terminal tab: the renderer republishes those,
    // so a host write would be overwritten and must not be attempted.
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      color: '#ff8800'
    })
    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]?.find((tab) => tab.id === 'host-tab')?.color
    ).toBeNull()
  })

  it('restores the name after the host forgets the live tab', async () => {
    const { runtime } = await makeRuntimeWithPublishedChat()
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: 'Release notes'
    })

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    const client = subscribeClient(runtime)
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: SESSION_ID,
      agent: 'codex',
      activate: true
    })

    expect(client.chatTitle()).toBe('Release notes')
  })

  it('publishes the agent placeholder when the name is cleared, never an empty label', async () => {
    const { runtime } = await makeRuntimeWithPublishedChat()
    const client = subscribeClient(runtime)
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: 'Release notes'
    })

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: '   '
    })
    expect(client.chatTitle()).toBe('Codex Chat')

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      title: null
    })
    expect(client.chatTitle()).toBe('Codex Chat')
  })

  it('leaves an unnamed chat on its placeholder when another prop changes', async () => {
    const { runtime } = await makeRuntimeWithPublishedChat()
    const client = subscribeClient(runtime)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: CHAT_TAB_ID,
      color: '#3b82f6'
    })

    expect(client.chatTitle()).toBe('Codex Chat')
  })
})

describe('session.tabs.setTabProps mobile reachability', () => {
  it('is callable by a paired mobile client', async () => {
    const { MOBILE_RPC_METHOD_ALLOWLIST } =
      await import('../runtime-rpc/runtime-rpc-mobile-method-allowlist')
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('session.tabs.setTabProps')).toBe(true)
  })

  it('accepts a title and rejects a non-string one', async () => {
    const { SetTabProps } = await import('../rpc/methods/session-tabs-schemas')
    expect(
      SetTabProps.parse({ worktree: `id:${TEST_WORKTREE_ID}`, tabId: CHAT_TAB_ID, title: 'Named' })
    ).toMatchObject({ title: 'Named' })
    expect(
      SetTabProps.parse({ worktree: `id:${TEST_WORKTREE_ID}`, tabId: CHAT_TAB_ID, title: null })
    ).toMatchObject({ title: null })
    expect(() =>
      SetTabProps.parse({ worktree: `id:${TEST_WORKTREE_ID}`, tabId: CHAT_TAB_ID, title: 7 })
    ).toThrow()
  })
})

// Keep vi referenced so the shared mock module's lifecycle matches sibling specs.
void vi
