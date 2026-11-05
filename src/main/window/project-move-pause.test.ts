import { EventEmitter } from 'node:events'
import { ipcMain as ipc, type BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectMovePauseRequest } from '../../shared/project-move-pause'
import type { WorkspaceSleepOutcome, WorkspaceSleepTarget } from '../../shared/workspace-sleep'

type PauseResponseFixture = { requestId?: string; protocol?: number } & (
  | { phase: 'prepare'; targets: WorkspaceSleepTarget[] }
  | { phase: 'persist' }
  | { phase: 'error'; error: string }
)

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
import { pauseWorkspacesForProjectMove } from './project-move-pause'

function fixture() {
  const windowEvents = new EventEmitter()
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn<(channel: string, request: ProjectMovePauseRequest) => void>()
  })
  const window = Object.assign(windowEvents, { isDestroyed: () => false, webContents })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the broker uses only the lifecycle and webContents members supplied here.
  const mainWindow = window as unknown as BrowserWindow
  const outcomes: WorkspaceSleepOutcome[] = [
    {
      worktreeId: 'wt',
      chatFailed: false,
      receipts: [{ executionHostId: 'local', stoppedSessionIds: ['chat'] }]
    }
  ]
  const sleepWorkspaces = vi.fn(async () => outcomes)
  const request = (): ProjectMovePauseRequest => {
    const value = webContents.send.mock.calls.at(-1)?.[1]
    if (!value) {
      throw new Error('no request')
    }
    return value
  }
  const respond = (value: PauseResponseFixture, sender: unknown = webContents): void => {
    ipc.emit(
      'ui:projectMovePauseResponse',
      { sender },
      { requestId: request().requestId, protocol: 1, ...value }
    )
  }
  const prepare = (): void =>
    respond({
      phase: 'prepare',
      targets: [{ worktreeId: 'wt', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }]
    })
  return { window, mainWindow, webContents, sleepWorkspaces, outcomes, request, respond, prepare }
}

describe('main-owned project move pause', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipc.removeAllListeners()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for an explicit renderer persistence receipt and preserves all stop receipts', async () => {
    const f = fixture()
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt', 'wt'])
    f.prepare()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sleepWorkspaces).toHaveBeenCalledWith({
      targets: [
        { worktreeId: 'wt', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }
      ],
      markChatsAsleep: false,
      projectMovePauseId: expect.any(String)
    })
    let returned = false
    void paused.then(() => {
      returned = true
    })
    expect(f.request().phase).toBe('persist')
    expect(returned).toBe(false)
    f.respond({ phase: 'persist' })
    await expect(paused).resolves.toEqual(f.outcomes)
    expect(f.request().phase).toBe('release')
    expect(ipc.listenerCount('ui:projectMovePauseResponse')).toBe(0)
    expect(f.webContents.eventNames()).toEqual([])
  })

  it('shares one lifecycle listener across overlapping pauses and releases it after', async () => {
    const f = fixture()
    const paused = Array.from({ length: 12 }, () =>
      pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt'])
    )

    expect(ipc.listenerCount('ui:projectMovePauseResponse')).toBe(1)
    expect(f.window.listenerCount('closed')).toBe(1)
    for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      expect(f.webContents.listenerCount(event)).toBe(1)
    }
    f.webContents.emit('render-process-gone')

    await Promise.all(paused.map((pause) => expect(pause).rejects.toThrow('renderer_unavailable')))
    expect(f.window.eventNames()).toEqual([])
    expect(f.webContents.eventNames()).toEqual([])
    expect(ipc.listenerCount('ui:projectMovePauseResponse')).toBe(0)
  })

  it('does not stop hosts when an old preload or follower never answers the handshake', async () => {
    const f = fixture()
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt'])
    const rejected = expect(paused).rejects.toThrow('renderer_timeout')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(f.sleepWorkspaces).not.toHaveBeenCalled()
    expect(ipc.listenerCount('ui:projectMovePauseResponse')).toBe(0)
  })

  it('ignores another window, stale request and unsupported protocol', async () => {
    const f = fixture()
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt'])
    f.respond({ phase: 'prepare', targets: [] }, {})
    f.respond({ phase: 'prepare', targets: [], requestId: 'stale' })
    f.respond({ phase: 'prepare', targets: [], protocol: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sleepWorkspaces).not.toHaveBeenCalled()
    f.prepare()
    await vi.advanceTimersByTimeAsync(0)
    f.respond({ phase: 'persist' })
    await paused
  })

  it('rejects reload during the host stop instead of accepting a new renderer persistence reply', async () => {
    const f = fixture()
    const stop = Promise.withResolvers<WorkspaceSleepOutcome[]>()
    f.sleepWorkspaces.mockReturnValue(stop.promise)
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt'])
    f.prepare()
    await vi.advanceTimersByTimeAsync(0)
    f.webContents.emit('did-start-navigation', {}, 'about:blank', false, true)
    stop.resolve(f.outcomes)
    await expect(paused).rejects.toThrow('renderer_unavailable')
    expect(f.webContents.send.mock.calls.map(([, value]) => value.phase)).toEqual(['prepare'])
  })

  it('propagates failed durability without returning success to the exporter', async () => {
    const f = fixture()
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt'])
    f.prepare()
    await vi.advanceTimersByTimeAsync(0)
    f.respond({ phase: 'error', error: 'disk full' })
    await expect(paused).rejects.toMatchObject({ message: 'disk full', outcomes: f.outcomes })
    expect(f.request().phase).toBe('release')
  })

  it('retains partial stop failures and successful sibling receipts when renderer rollback fails', async () => {
    const f = fixture()
    f.outcomes[0].failure = 'terminal_liveness_unavailable'
    f.outcomes.push({
      worktreeId: 'sibling',
      chatFailed: false,
      receipts: [{ executionHostId: 'runtime:env', stoppedSessionIds: ['remote-chat'] }]
    })
    const paused = pauseWorkspacesForProjectMove(f.mainWindow, f, ['wt', 'sibling'])
    f.respond({
      phase: 'prepare',
      targets: ['wt', 'sibling'].map((worktreeId) => ({
        worktreeId,
        terminalHost: { kind: 'self' },
        chatHosts: [{ kind: 'self' }]
      }))
    })
    await vi.advanceTimersByTimeAsync(0)
    f.respond({ phase: 'error', error: 'host_terminal_stop_failed' })
    await expect(paused).rejects.toMatchObject({ outcomes: f.outcomes })
    expect(f.outcomes[1]?.receipts[0]?.stoppedSessionIds).toEqual(['remote-chat'])
  })
})
