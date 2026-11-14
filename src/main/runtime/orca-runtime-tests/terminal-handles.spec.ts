import { describe, expect, it, vi } from 'vitest'
import {
  dropFromHostInventory,
  registerBoundPty,
  registerLivePty
} from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store
} from './orca-runtime-test-fixtures.spec'

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
    runtime.syncWindowGraph(1, graph)
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
    const replay = runtime.syncWindowGraph(1, {
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

    const reconciled = runtime.syncWindowGraph(1, {
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

  it('surfaces stale terminal handles for stranded panes and recovers after same-pane wake', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-before-sleep'
        }
      ]
    })

    const beforeSleep = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const staleHandle = beforeSleep.terminals[0]?.handle ?? ''
    expect(staleHandle).toBeTruthy()

    // terminal.show is read-only; renderer wake/rebind publication must repair the handle surface.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })

    await expect(runtime.showTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-after-wake'
        }
      ]
    })
    runtime.onPtyData('pty-after-wake', 'resumed in place\n', 123)

    const resolved = runtime.resolveTerminalPane(paneKey)
    expect(resolved).toMatchObject({
      tabId,
      leafId,
      ptyId: 'pty-after-wake'
    })
    await expect(runtime.showTerminal(resolved.handle)).resolves.toMatchObject({
      handle: resolved.handle,
      tabId,
      leafId,
      ptyId: 'pty-after-wake',
      preview: 'resumed in place'
    })
  })

  it('returns an already-connected replacement instead of spawning another pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-cas'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, 'pty-old', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const oldHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    await dropFromHostInventory(runtime, 'pty-old')
    registerBoundPty(runtime, 'pty-new', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const recovered = await runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)

    expect(recovered.handle).not.toBe(oldHandle)
    expect(recovered.ptyId).toBe('pty-new')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('drops a stale leaf when a woken agent PTY is re-keyed to a new leaf on renderer reload', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Pre-allocated exported handles are the condition used by reload preservation.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)

    // A cold-restored leaf can have a new id while retaining the live agent PTY.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    // Duplicate leaves for one PTY share a handle and crash paired clients with duplicate React keys.
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
    await expect(runtime.showTerminal(after.terminals[0].handle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })
  })
})
