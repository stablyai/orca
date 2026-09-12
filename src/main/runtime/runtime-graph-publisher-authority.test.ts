import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRendererSyncWindowGraph } from '../../shared/runtime-types'
import { createRuntimeRendererNotificationSender } from '../window/runtime-renderer-notification-sender'
import { OrcaRuntimeService } from './orca-runtime'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from './runtime-graph-reload-lifecycle'

function graph(rendererGeneration = 'current'): RuntimeRendererSyncWindowGraph {
  return { rendererGeneration, tabs: [], leaves: [], mobileSessionTabs: [] }
}

function publishedRuntime() {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, graph())
  return runtime
}

function snapshot(runtime: OrcaRuntimeService) {
  const state = runtime as unknown as {
    tabs: Map<string, unknown>
    leaves: Map<string, unknown>
    rendererGeneration: string | null
    pendingHeadlessPromotionWindowId: number | null
  }
  return {
    status: runtime.getStatus(),
    tabs: structuredClone([...state.tabs]),
    leaves: structuredClone([...state.leaves]),
    generation: state.rendererGeneration,
    promotion: state.pendingHeadlessPromotionWindowId
  }
}

afterEach(() => vi.useRealTimers())

describe('runtime graph publisher authority', () => {
  it('recovers the current document after notification failure without changing its generation', () => {
    const runtime = publishedRuntime()
    runtime.markGraphReloadFailed(1, 'renderer-frame-unavailable')
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    expect(runtime.syncWindowGraph(1, graph()).graphStatus).toBe('ready')
  })

  it.each(['reloading', 'timeout', 'successor', 'process-gone'])(
    'fences a retired document after %s without mutating publication authority',
    async (phase) => {
      vi.useFakeTimers()
      const runtime = publishedRuntime()
      if (phase === 'process-gone') {
        runtime.markGraphReloadFailed(1, 'renderer-process-gone')
      } else {
        runtime.markRendererReloading(1)
      }
      if (phase === 'timeout') {
        await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)
      }
      if (phase === 'successor') {
        runtime.syncWindowGraph(1, graph('successor'))
      }
      const before = snapshot(runtime)
      expect(() => runtime.syncWindowGraph(1, graph())).toThrow('superseded renderer generation')
      expect(snapshot(runtime)).toEqual(before)
      expect(runtime.syncWindowGraph(1, graph('new-document')).graphStatus).toBe('ready')
    }
  )

  it.each(['ready', 'unavailable'])(
    'restores publication eligibility when navigation from %s is cancelled',
    (initial) => {
      const runtime = publishedRuntime()
      if (initial === 'unavailable') {
        runtime.markGraphReloadFailed(1, 'renderer-frame-unavailable')
      }
      const fence = runtime.markRendererReloading(1)!
      expect(runtime.markRendererReloadCancelled(1, fence)).toBe(true)
      expect(runtime.syncWindowGraph(1, graph()).graphStatus).toBe('ready')
    }
  )

  it('rejects a closed window before it can reclaim null authority or attach', () => {
    const runtime = publishedRuntime()
    runtime.markGraphUnavailable(1)
    const before = snapshot(runtime)
    expect(() => runtime.syncWindowGraph(1, graph())).toThrow('retired window')
    expect(snapshot(runtime)).toEqual(before)
    runtime.attachWindow(1)
    expect(snapshot(runtime)).toEqual(before)
    runtime.attachWindow(2)
    expect(runtime.syncWindowGraph(2, graph('new-window')).graphStatus).toBe('ready')
  })

  it('preflights duplicate tabs before headless promotion and preserves a valid successor', () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    runtime.markGraphReloadFailed(1, 'renderer-process-gone')
    const before = snapshot(runtime)
    const tab = {
      tabId: 'duplicate',
      worktreeId: 'folder:fixture',
      title: 'tab',
      activeLeafId: null,
      layout: null
    }
    expect(() => runtime.syncWindowGraph(1, { ...graph(), tabs: [tab, tab] })).toThrow(
      'duplicate_runtime_tab_id'
    )
    expect(snapshot(runtime)).toEqual(before)
    expect(() => runtime.syncWindowGraph(2, graph())).toThrow('pending desktop promotion')
    expect(snapshot(runtime)).toEqual(before)
    expect(runtime.syncWindowGraph(1, graph()).graphStatus).toBe('ready')
  })

  it('keeps headless fallback available after a promotion notification send fails', () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    runtime.markGraphReloadFailed(1, 'renderer-frame-unavailable')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: 0,
      graphStatus: 'ready'
    })
    expect(runtime.syncWindowGraph(1, graph()).graphStatus).toBe('ready')
  })

  it('preserves generation-absent runtime callers through reload', () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.markRendererReloading(1)
    expect(runtime.syncWindowGraph(1, { tabs: [], leaves: [] }).graphStatus).toBe('ready')
  })

  it.each(['repo::/fixture', 'folder:fixture'])(
    'recovers mobile inventory and the existing PTY incarnation for %s',
    async (worktreeId) => {
      vi.useFakeTimers()
      const runtime = new OrcaRuntimeService()
      runtime.registerPty('pty', worktreeId, null, {
        tabId: 'tab',
        leafId: 'leaf',
        incarnationId: 'same-process'
      })
      const publication: RuntimeRendererSyncWindowGraph = {
        ...graph(),
        tabs: [{ tabId: 'tab', worktreeId, title: 'Terminal', activeLeafId: 'leaf', layout: null }],
        leaves: [{ tabId: 'tab', worktreeId, leafId: 'leaf', paneRuntimeId: 1, ptyId: 'pty' }],
        mobileSessionTabs: [
          {
            worktree: worktreeId,
            publicationEpoch: 'current',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: 'tab::leaf',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab::leaf',
                parentTabId: 'tab',
                leafId: 'leaf',
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      }
      const events: unknown[] = []
      runtime.onMobileSessionTabsChanged((event) => events.push(event))
      runtime.syncWindowGraph(1, publication)
      await vi.advanceTimersByTimeAsync(100)
      const before = snapshot(runtime)
      runtime.markGraphReloadFailed(1, 'renderer-frame-unavailable')
      runtime.syncWindowGraph(1, {
        ...publication,
        leaves: [{ ...publication.leaves[0], ptyId: null }]
      })
      await vi.advanceTimersByTimeAsync(100)
      const after = snapshot(runtime)
      expect(after.leaves).toEqual(before.leaves)
      expect(after.status.graphStatus).toBe('ready')
      expect(events.length).toBeGreaterThan(0)
      expect(events.at(-1)).toMatchObject({
        worktree: worktreeId,
        tabs: [expect.objectContaining({ type: 'terminal', title: 'Terminal' })]
      })
      const ptys = (runtime as unknown as { ptysById: Map<string, { incarnationId: string }> })
        .ptysById
      expect(ptys.get('pty')?.incarnationId).toBe('same-process')
    }
  )

  it('restores the notification owner before graph callbacks attempt delivery', () => {
    const runtime = publishedRuntime()
    const send = vi.fn().mockImplementationOnce(() => {
      throw new Error('frame unavailable')
    })
    const sender = createRuntimeRendererNotificationSender({
      isWindowDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      onFailure: (reason) => runtime.markGraphReloadFailed(1, reason),
      warn: vi.fn()
    })
    runtime.setNotifier({
      graphPublicationAccepted: (windowId: number) => {
        if (windowId === 1) {
          sender.onGraphPublicationAccepted()
        }
      }
    } as never)
    expect(sender.send('repos:changed')).toBe(false)
    const delivery = vi.fn(() => expect(sender.send('ui:createTerminal')).toBe(true))
    const callbacks = (runtime as unknown as { graphSyncCallbacks: (() => void)[] })
      .graphSyncCallbacks
    callbacks.push(delivery)
    runtime.syncWindowGraph(1, graph())
    expect(delivery).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    callbacks.splice(callbacks.indexOf(delivery), 1)
    sender.close()
    runtime.syncWindowGraph(1, graph())
    expect(sender.send('repos:changed')).toBe(false)
  })
})
