import { describe, expect, it } from 'vitest'
import { createHudStore, type HudState } from './hud-store'
import {
  WorktreeDashboardController,
  formatElapsedLabel,
  type DashboardTimer
} from './worktree-dashboard-state'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'

function fixtureState(): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

class FakeRpcPort implements RpcPort {
  calls: { method: string; params?: unknown }[] = []
  queue: RpcResponse[] = []

  sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
    this.calls.push({ method, params })
    const next = this.queue.shift()
    if (!next) {
      return Promise.reject(new Error('no response queued'))
    }
    return Promise.resolve(next)
  }

  subscribe(): () => void {
    throw new Error('not used by worktree-dashboard-state')
  }
}

function okResponse(worktrees: unknown[]): RpcResponse {
  return { id: '1', ok: true, result: { worktrees }, _meta: { runtimeId: 'test' } }
}

/** Fake timer: setInterval just records the callback; tests fire it manually via `fire()`. */
function fakeTimer() {
  let cb: (() => void) | null = null
  let cleared = false
  const timer: DashboardTimer = {
    setInterval: (fn) => {
      cb = fn
      return 'handle'
    },
    clearInterval: () => {
      cleared = true
    }
  }
  return { timer, fire: () => cb?.(), isCleared: () => cleared }
}

describe('formatElapsedLabel', () => {
  it('formats sub-hour durations in minutes', () => {
    expect(formatElapsedLabel(0, 0)).toBe('0m')
    expect(formatElapsedLabel(0, 12 * 60_000)).toBe('12m')
  })

  it('formats hour+ durations as HhMMm', () => {
    expect(formatElapsedLabel(0, 65 * 60_000)).toBe('1h05m')
  })

  it('clamps negative durations (clock skew) to 0m', () => {
    expect(formatElapsedLabel(10_000, 0)).toBe('0m')
  })
})

describe('WorktreeDashboardController', () => {
  it('polls immediately on start when visible+foreground', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(
      okResponse([{ worktreeId: 'w1', displayName: 'api', status: 'working', lastOutputAt: 0 }])
    )
    const { timer } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 5 * 60_000,
      timer
    })

    controller.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(port.calls).toEqual([{ method: 'worktree.ps', params: { limit: 50 } }])
    expect(store.getState().dashboard.rows).toEqual([
      { worktreeId: 'w1', displayName: 'api', status: 'working', elapsedLabel: '5m' }
    ])
    expect(store.getState().dashboard.stale).toBe(false)
  })

  it('skips a tick when not visible or not foregrounded (paused)', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    let visible = false
    const { timer, fire } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => visible,
      isForeground: () => true,
      now: () => 0,
      timer
    })

    controller.start() // initial tick: not visible, skipped
    await Promise.resolve()
    expect(port.calls).toHaveLength(0)

    fire() // interval tick: still not visible
    await Promise.resolve()
    expect(port.calls).toHaveLength(0)

    visible = true
    port.queue.push(okResponse([]))
    fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.calls).toHaveLength(1)
  })

  it('refreshNow polls immediately regardless of visibility (push-nudge)', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(okResponse([]))
    const { timer } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => false,
      isForeground: () => false,
      now: () => 0,
      timer
    })

    controller.start() // no poll (hidden)
    await Promise.resolve()
    expect(port.calls).toHaveLength(0)

    controller.refreshNow()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.calls).toHaveLength(1)
  })

  it('marks stale on failure but keeps the last-proven rows and fetchedAt', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(okResponse([{ worktreeId: 'w1', displayName: 'api' }]))
    const { timer, fire } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 1000,
      timer
    })

    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    const provenRows = store.getState().dashboard.rows
    const provenFetchedAt = store.getState().dashboard.fetchedAt
    expect(provenRows).toHaveLength(1)

    // Next tick's request rejects entirely (simulated transport failure).
    fire()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().dashboard.stale).toBe(true)
    expect(store.getState().dashboard.rows).toEqual(provenRows)
    expect(store.getState().dashboard.fetchedAt).toBe(provenFetchedAt)
  })

  it('marks stale when the response is ok:false, keeping counts', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(okResponse([{ worktreeId: 'w1', displayName: 'api' }]))
    port.queue.push({
      id: '2',
      ok: false,
      error: { code: 'x', message: 'x' },
      _meta: { runtimeId: 'test' }
    })
    const { timer, fire } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 1000,
      timer
    })

    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    fire()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().dashboard.stale).toBe(true)
    expect(store.getState().dashboard.rows).toHaveLength(1)
  })

  it('stop() clears the interval', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(okResponse([]))
    const { timer, isCleared } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 0,
      timer
    })

    controller.start()
    controller.stop()

    expect(isCleared()).toBe(true)
  })

  it('treats a null lastOutputAt (no recorded activity) the same as absent, not epoch 0', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(
      okResponse([{ worktreeId: 'w1', displayName: 'idle', status: 'active', lastOutputAt: null }])
    )
    const { timer } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 5 * 60_000,
      timer
    })

    controller.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().dashboard.rows).toEqual([
      { worktreeId: 'w1', displayName: 'idle', status: 'active', elapsedLabel: undefined }
    ])
  })

  it('degrades gracefully: absent status and lastOutputAt', async () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    port.queue.push(okResponse([{ worktreeId: 'w1', displayName: 'no-status' }]))
    const { timer } = fakeTimer()
    const controller = new WorktreeDashboardController(store, {
      port,
      isVisible: () => true,
      isForeground: () => true,
      now: () => 0,
      timer
    })

    controller.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().dashboard.rows).toEqual([
      { worktreeId: 'w1', displayName: 'no-status', status: undefined, elapsedLabel: undefined }
    ])
  })
})
