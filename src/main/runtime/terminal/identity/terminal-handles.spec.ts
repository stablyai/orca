import { describe, expect, it, vi } from 'vitest'
import { dropFromHostInventory, registerBoundPty } from '../layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('surfaces stale terminal handles for stranded panes and recovers after same-pane wake', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)

    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
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
    await runtime.syncWindowGraph(1, {
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

    await runtime.syncWindowGraph(1, {
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
    await runtime.syncWindowGraph(TEST_WINDOW_ID, {
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
    await runtime.syncWindowGraph(TEST_WINDOW_ID, {
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
