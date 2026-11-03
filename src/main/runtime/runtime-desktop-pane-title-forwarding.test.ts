import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { electronMocks, OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub
} from './rpc/methods/structured-agent-session-rpc.test-fixture'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'

const SPLIT_ROOT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
  second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
}
const SINGLE_ROOT: TerminalPaneLayoutNode = { type: 'leaf', leafId: HEADLESS_LEAF_ID }

// #30386: a desktop host's window owns its layout, so a client's pane rename must reach the window.
function desktopHostRuntime() {
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.attachWindow(1)
  const setPaneTitle = vi.fn(() => true)
  const renameTerminal = vi.fn()
  runtime.setNotifier({ ...createMobileCreateTestNotifier(vi.fn()), setPaneTitle, renameTerminal })
  const savedLayout = () => getSession().terminalLayoutsByTabId['host-tab']
  const before = structuredClone(savedLayout())
  const renamePanes = (
    root: TerminalPaneLayoutNode,
    titlesByLeafId: Record<string, string> | undefined,
    renamedLeafIds: string[] = [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID]
  ) =>
    runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root,
      expandedLeafId: null,
      ...(titlesByLeafId ? { titlesByLeafId } : {}),
      renamedLeafIds
    })
  return { runtime, setPaneTitle, renameTerminal, renamePanes, savedLayout, before }
}

describe('client pane names on a host with its own desktop window', () => {
  it('passes each pane name, and each cleared one, to the window without renaming the tab', async () => {
    const { setPaneTitle, renameTerminal, renamePanes, savedLayout, before } = desktopHostRuntime()

    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: ' server ' })

    expect(setPaneTitle.mock.calls).toEqual([
      ['host-tab', HEADLESS_LEAF_ID, 'server'],
      ['host-tab', HEADLESS_SECOND_LEAF_ID, null]
    ])
    expect(renameTerminal).not.toHaveBeenCalled()
    // The window saves what it shows; main must not write over the window's layout.
    expect(savedLayout()).toEqual(before)
  })

  it('passes on only the panes the client renamed', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'server' }, [HEADLESS_SECOND_LEAF_ID])

    expect(setPaneTitle.mock.calls).toEqual([['host-tab', HEADLESS_SECOND_LEAF_ID, null]])
  })

  it('ignores a resent title map, as an older client sends on every divider drag', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()

    // Its map can predate a name the host set since, so it must not revert that name.
    await renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'stale' }, [])

    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('fails the call when the window cannot take the name, so the client retries', async () => {
    const { setPaneTitle, renamePanes } = desktopHostRuntime()
    setPaneTitle.mockReturnValue(false)

    await expect(renamePanes(SPLIT_ROOT, { [HEADLESS_LEAF_ID]: 'server' })).rejects.toThrow(
      'runtime_unavailable'
    )
  })

  it("never turns the tab's own name into a single pane's name", async () => {
    const { setPaneTitle, renameTerminal, renamePanes } = desktopHostRuntime()

    await renamePanes(SINGLE_ROOT, { [HEADLESS_LEAF_ID]: 'Persisted Terminal' })

    expect(setPaneTitle).not.toHaveBeenCalled()
    expect(renameTerminal).not.toHaveBeenCalled()
  })
})

it('routes old-client chat tab renames to the owning record with or without an attached window', async () => {
  installStructuredHostStub()
  hostCalls.setUserConversationName = vi.fn(async () => ({
    name: 'Saved through tab props',
    applied: true
  }))
  try {
    for (const attached of [true, false]) {
      const desktop = desktopHostRuntime()
      const runtime = attached ? desktop.runtime : new OrcaRuntimeService(null)
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
      const snapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'chat-rename',
        snapshotVersion: 1,
        activeGroupId: 'group',
        activeTabId: 'agent-session:session-alpha',
        activeTabType: 'agent-session',
        tabs: [
          {
            type: 'agent-session',
            id: 'agent-session:session-alpha',
            sessionId: 'session-alpha',
            agent: 'codex',
            title: 'Codex Chat',
            isActive: true
          }
        ]
      }
      runtime['storeMobileSessionSnapshot'](TEST_WORKTREE_ID, snapshot)
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        {
          id: 'rename',
          authToken: 'token',
          method: 'session.tabs.setTabProps',
          params: {
            worktree: `id:${TEST_WORKTREE_ID}`,
            tabId: snapshot.activeTabId,
            customTitle: 'Saved through tab props'
          }
        },
        (reply) => replies.push(reply),
        { clientKind: 'mobile', clientCapabilities: [] }
      )
      expect(JSON.parse(replies[0]), replies[0]).toMatchObject({
        ok: true,
        result: { updated: true }
      })
      expect(hostCalls.setUserConversationName).toHaveBeenLastCalledWith(
        'session-alpha',
        'Saved through tab props',
        'rename'
      )
      expect(desktop.renameTerminal).not.toHaveBeenCalled()
    }
    expect(hostCalls.setUserConversationName).toHaveBeenCalledTimes(2)
  } finally {
    clearStructuredHostStub()
  }
})
