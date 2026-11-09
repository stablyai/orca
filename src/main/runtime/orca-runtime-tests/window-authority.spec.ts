import '../../../shared/layout-owner-switch'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../orca-runtime'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from '../session-graph/runtime-graph-reload-lifecycle'
import '../orca-runtime-test-mocks/setup.spec'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('marks live bindings again when reopening after a promoted window closes', () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeWorktreeIdsOnShutdown: []
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.attachWindow(TEST_WINDOW_ID)
    ;(runtimeStore.setWorkspaceSession as unknown as (next: WorkspaceSessionState) => void)({
      ...getSession(),
      activeWorktreeIdsOnShutdown: []
    })
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    runtime.attachWindow(2)

    expect(getSession().activeWorktreeIdsOnShutdown).toEqual([TEST_WORKTREE_ID])
  })

  it('preserves live SSH session identities when promoting a headless runtime', () => {
    const remotePtyId = 'ssh:ssh-1@@persisted-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeWorktreeIdsOnShutdown: [],
        activeConnectionIdsAtShutdown: [],
        remoteSessionIdsByTabId: {},
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: remotePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: remotePtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty(remotePtyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(getSession()).toMatchObject({
      activeWorktreeIdsOnShutdown: [TEST_WORKTREE_ID],
      activeConnectionIdsAtShutdown: ['ssh-1'],
      remoteSessionIdsByTabId: { 'host-tab': remotePtyId }
    })
  })

  it('restores a surviving renderer when its reload is cancelled', () => {
    const runtime = createRuntime()
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    const fence = runtime.markRendererReloading(TEST_WINDOW_ID)
    if (fence === null) {
      throw new Error('expected active renderer reload fence')
    }

    expect(fence.recovery).toBe('renderer')
    expect(runtime.getStatus().graphStatus).toBe('reloading')
    expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, fence)).toBe(true)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('keeps an earlier committed reload fenced when a later reload is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      const committedFence = runtime.markRendererReloading(TEST_WINDOW_ID)
      const cancelledFence = runtime.markRendererReloading(TEST_WINDOW_ID)
      if (committedFence === null || cancelledFence === null) {
        throw new Error('expected active renderer reload fences')
      }

      expect(cancelledFence.recovery).toBe('reloading')
      expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, committedFence)).toBe(false)
      expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, cancelledFence)).toBe(false)
      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS - 1)
      expect(runtime.getStatus().graphStatus).toBe('reloading')
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.getStatus().graphStatus).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores headless authority when desktop promotion navigation is cancelled', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    const fence = runtime.markRendererReloading(TEST_WINDOW_ID)
    if (fence === null) {
      throw new Error('expected active promotion reload fence')
    }

    expect(fence.recovery).toBe('headless')
    expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, fence)).toBe(false)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('restores headless graph authority after a promoted renderer reload times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      runtime.attachWindow(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
        graphStatus: 'ready'
      })
      expect((await runtime.listTerminals()).terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ptyId: 'persisted-pty', connected: true, writable: true })
        ])
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves a desktop graph to unavailable when its reload times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      runtime.markRendererReloading(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'unavailable',
        rendererGraphEpoch: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a failed headless promotion and accepts a later renderer generation', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)

    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })

    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('retires the headless fallback after renderer promotion succeeds', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'unavailable'
    })

    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('does not let a superseded reload timeout overwrite a newer renderer graph', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      runtime.markRendererReloading(TEST_WINDOW_ID)
      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)
      runtime.markRendererReloading(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'reloading'
      })

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'unavailable'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a same-frame graph publication from the superseded renderer generation', () => {
    const runtime = createRuntime()
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer-a'
    })
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(() =>
      runtime.syncWindowGraph(TEST_WINDOW_ID, {
        tabs: [],
        leaves: [],
        rendererGeneration: 'renderer-a'
      })
    ).toThrow('Runtime graph publisher belongs to a superseded renderer generation')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'reloading'
    })
  })

  it('keeps a restored headless graph pinned to the failed promotion window', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(() =>
      runtime.syncWindowGraph(2, {
        tabs: [],
        leaves: [],
        rendererGeneration: 'renderer-b'
      })
    ).toThrow('Runtime graph publisher does not match the pending desktop promotion')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('promotes a reopened serve window and hands back again when it closes', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    runtime.attachWindow(2)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: 2,
      graphStatus: 'reloading'
    })
    runtime.syncWindowGraph(2, { tabs: [], leaves: [] })
    runtime.markGraphReady(2)
    expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: 2, graphStatus: 'ready' })

    runtime.markGraphUnavailable(2)

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
  })
})
