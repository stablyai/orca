import { describe, expect, it, vi } from 'vitest'

import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE = 'repo::G:\\git\\example'
const ALIAS = 'repo::G:/git/example'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = `tab::${LEAF}`

function snapshot(
  worktree = WORKTREE,
  ptyId = 'pty-existing',
  binding: 'direct' | 'layout' = 'direct'
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: TAB,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: TAB,
        parentTabId: 'tab',
        leafId: LEAF,
        ptyId: binding === 'layout' ? null : ptyId,
        ...(binding === 'layout'
          ? {
              parentLayout: {
                root: { type: 'leaf' as const, leafId: LEAF },
                activeLeafId: LEAF,
                expandedLeafId: null,
                ptyIdsByLeafId: { [LEAF]: ptyId }
              }
            }
          : {}),
        title: 'Existing conversation',
        isActive: true
      }
    ]
  }
}

async function publishGraph(
  runtime: OrcaRuntimeService,
  worktree = WORKTREE,
  additionalSnapshots: RuntimeMobileSessionTabsSnapshot[] = [],
  ptyId = 'pty-existing',
  binding: 'direct' | 'layout' = 'direct'
): Promise<void> {
  await runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: worktree,
        title: 'Existing conversation',
        activeLeafId: LEAF,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab',
        worktreeId: worktree,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: 'Existing conversation'
      }
    ],
    mobileSessionTabs: [snapshot(worktree, ptyId, binding), ...additionalSnapshots]
  })
}

describe('session tab workspace path aliases', () => {
  it('delivers a later canonical publication to an early alias subscriber without a false empty frame', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: unknown[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'sub-early',
        authToken: 'token',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${ALIAS}` }
      },
      (message) => messages.push(JSON.parse(message)),
      { connectionId: 'alias-connection' }
    )
    expect(messages).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ type: 'snapshot', worktree: ALIAS, tabs: [] })
      })
    )

    await publishGraph(runtime)

    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            type: 'updated',
            worktree: ALIAS,
            tabs: expect.arrayContaining([expect.objectContaining({ id: TAB })])
          })
        })
      )
    )
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ type: 'updated', worktree: ALIAS, tabs: [] })
      })
    )
    runtime.cleanupSubscriptionsForConnection('alias-connection')
  })

  // Stream frames must use one workspace spelling or clients split tabs across alias keys.
})
