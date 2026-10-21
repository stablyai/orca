import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeSleepRequest } from '../../shared/worktree-sleep-request'

const ipcEmitter = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.removeListener(channel, listener)
  }
}))

const { requestWorktreeSleepFromRenderer, worktreeSleepTimeoutMs } =
  await import('./worktree-sleep-request-relay')

class FakeContents extends EventEmitter {
  destroyed = false
  readonly sent: WorktreeSleepRequest[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(_channel: string, request: WorktreeSleepRequest): void {
    this.sent.push(request)
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents()
  isDestroyed(): boolean {
    return false
  }
}

const respond = (sender: unknown, response: Record<string, unknown>): void => {
  ipcEmitter.emit('ui:worktreeSleepResponse', { sender }, response)
}

let window: FakeWindow
beforeEach(() => {
  ipcEmitter.removeAllListeners()
  window = new FakeWindow()
})
afterEach(() => vi.useRealTimers())

describe('requestWorktreeSleepFromRenderer', () => {
  it("resolves with the renderer's failed workspaces once its own window acks", async () => {
    const pending = requestWorktreeSleepFromRenderer(window, ['wt-1', 'wt-2'])
    const [request] = window.webContents.sent
    expect(request?.worktreeIds).toEqual(['wt-1', 'wt-2'])

    respond(new FakeContents(), { requestId: request?.requestId })
    respond(window.webContents, { requestId: 'other' })
    respond(window.webContents, { requestId: request?.requestId, failedWorktreeIds: ['wt-2'] })

    await expect(pending).resolves.toEqual({ failedWorktreeIds: ['wt-2'] })
    expect(ipcEmitter.listenerCount('ui:worktreeSleepResponse')).toBe(0)
    expect(window.listenerCount('closed')).toBe(0)
  })

  it('rejects with the error the renderer reports', async () => {
    const pending = requestWorktreeSleepFromRenderer(window, ['wt-1'])
    respond(window.webContents, {
      requestId: window.webContents.sent[0]?.requestId,
      error: 'persist failed'
    })
    await expect(pending).rejects.toThrow('persist failed')
  })

  it.each([
    ['the window closes', (target: FakeWindow) => target.emit('closed')],
    ['the renderer dies', (target: FakeWindow) => target.webContents.emit('render-process-gone')],
    ['the renderer reloads', (target: FakeWindow) => target.webContents.emit('did-start-loading')]
  ])('rejects renderer_unavailable when %s', async (_name, lose) => {
    const pending = requestWorktreeSleepFromRenderer(window, ['wt-1'])
    lose(window)
    await expect(pending).rejects.toThrow('renderer_unavailable')
    expect(ipcEmitter.listenerCount('ui:worktreeSleepResponse')).toBe(0)
    expect(window.webContents.listenerCount('destroyed')).toBe(0)
    expect(window.webContents.listenerCount('did-start-loading')).toBe(0)
  })

  it('rejects renderer_unavailable up front when the renderer is already gone', async () => {
    window.webContents.destroyed = true
    await expect(requestWorktreeSleepFromRenderer(window, ['wt-1'])).rejects.toThrow(
      'renderer_unavailable'
    )
    expect(window.webContents.sent).toEqual([])
  })

  it('times out instead of waiting forever', async () => {
    vi.useFakeTimers()
    const pending = requestWorktreeSleepFromRenderer(window, ['wt-1'])
    let done = false
    const settled = expect(pending.finally(() => (done = true))).rejects.toThrow(
      'worktree_sleep_timeout'
    )
    await vi.advanceTimersByTimeAsync(29_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(ipcEmitter.listenerCount('ui:worktreeSleepResponse')).toBe(0)
  })

  it('scales the wait with the workspaces, capped at five minutes', () => {
    expect(worktreeSleepTimeoutMs(0)).toBe(20_000)
    expect(worktreeSleepTimeoutMs(3)).toBe(50_000)
    expect(worktreeSleepTimeoutMs(28)).toBe(300_000)
    expect(worktreeSleepTimeoutMs(500)).toBe(300_000)
  })
})
