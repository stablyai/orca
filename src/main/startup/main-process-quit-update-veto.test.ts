import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

it('keeps startup services live when the updater has vetoed before-quit', async () => {
  vi.resetModules()
  const app = new EventEmitter()
  const fenceAndCloseNow = vi.fn()
  const setMobileRelayPairingProvider = vi.fn()
  const unsubscribeAgentAwakeStatusChanges = vi.fn()
  const dispose = vi.fn()
  const stop = vi.fn()
  const stopPush = vi.fn()
  const state = {
    isQuitting: false,
    desktopRelayService: { fenceAndCloseNow },
    runtimeRpc: { setMobileRelayPairingProvider },
    unsubscribeAgentAwakeStatusChanges,
    agentAwakeService: { dispose },
    rateLimits: { stop },
    desktopPushService: { stop: stopPush }
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  const { registerQuitTask } = await import('../quit-task-registry')
  const flushCloudSessions = vi.fn()
  const cancelHistoryGc = vi.fn()
  const destroyTray = vi.fn()
  registerQuitTask('cloud-sessions', 'cloud-sessions', flushCloudSessions)
  registerQuitTask('history-gc', 'history-gc', cancelHistoryGc)
  registerQuitTask('tray', 'tray', destroyTray)
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  installMainProcessQuitHandlers()

  app.emit('before-quit', { defaultPrevented: true })

  expect(flushCloudSessions).not.toHaveBeenCalled()
  expect(cancelHistoryGc).not.toHaveBeenCalled()
  expect(state.isQuitting).toBe(false)
  expect(fenceAndCloseNow).not.toHaveBeenCalled()
  expect(setMobileRelayPairingProvider).not.toHaveBeenCalled()
  expect(unsubscribeAgentAwakeStatusChanges).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(state.agentAwakeService).toEqual({ dispose })
  expect(state.unsubscribeAgentAwakeStatusChanges).toBe(unsubscribeAgentAwakeStatusChanges)

  app.emit('before-quit', { defaultPrevented: false })

  expect(state.isQuitting).toBe(true)
  expect(fenceAndCloseNow).toHaveBeenCalledOnce()
  expect(setMobileRelayPairingProvider).toHaveBeenCalledWith(null)
  expect(unsubscribeAgentAwakeStatusChanges).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect(flushCloudSessions).toHaveBeenCalledOnce()
  expect(cancelHistoryGc).toHaveBeenCalledOnce()
  expect(stopPush).not.toHaveBeenCalled()
  expect(destroyTray).not.toHaveBeenCalled()
})

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  vi.resetModules()
})
