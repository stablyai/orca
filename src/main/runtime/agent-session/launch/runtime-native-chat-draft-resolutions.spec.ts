import { describe, expect, it, vi } from 'vitest'
import { registerLivePty } from '../../terminal/layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { RuntimeSyncWindowGraph } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { store } from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('routes a launch-draft resolution to the handle-owning local and remote renderers', async () => {
    const runtime = new OrcaRuntimeService(store)
    const nativeChatLaunchDraftResolved = vi.fn()
    const events: RuntimeClientEvent[] = []
    runtime.setNotifier({ nativeChatLaunchDraftResolved } as never)
    runtime.onClientEvent((event) => events.push(event))
    runtime.attachWindow(1)
    const graph: RuntimeSyncWindowGraph = {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'launch-draft-epoch',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude',
              launchDraft: 'seed',
              launchDraftCreatedAt: 7,
              isActive: true
            }
          ]
        }
      ]
    }
    registerLivePty(runtime, 'pty-1', 'repo-1::/tmp/worktree-a', null, {
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await runtime.syncWindowGraph(1, graph)
    const listed = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileTab = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!mobileTab?.terminal) {
      throw new Error('expected mobile terminal handle')
    }
    expect(mobileTab).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 7 })

    runtime.notifyNativeChatLaunchDraftResolved(mobileTab.terminal, {
      text: 'seed',
      createdAt: 7
    })

    expect(nativeChatLaunchDraftResolved).toHaveBeenCalledWith('tab-1', {
      text: 'seed',
      createdAt: 7
    })
    expect(events).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    expect(runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot()).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    const retired = (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
      (tab) => tab.type === 'terminal'
    )
    expect(retired).not.toHaveProperty('launchDraft')
    expect(retired).not.toHaveProperty('launchDraftCreatedAt')

    runtime.markRendererReloading(1)
    const replay = await runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 2
      }))
    })
    expect(replay.nativeChatLaunchDraftResolutions).toEqual([
      { tabId: 'tab-1', text: 'seed', createdAt: 7 }
    ])
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).not.toHaveProperty('launchDraft')

    const reconciled = await runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 3,
        tabs: snapshot.tabs.map((tab) => {
          if (tab.type !== 'terminal') {
            return tab
          }
          return { ...tab, launchDraftCreatedAt: 8 }
        })
      }))
    })
    expect(reconciled.nativeChatLaunchDraftResolutions).toBeUndefined()
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 8 })
  })
})
