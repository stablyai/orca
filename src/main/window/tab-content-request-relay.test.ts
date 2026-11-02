import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { TerminalNotPlacedError } from '../runtime/session-tabs/terminal-not-placed-error'

const ipcEmitter = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.removeListener(channel, listener)
  }
}))

it('sends its deadline, and takes no answer by then (plus grace) as a change the window refused', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const { requestTabContentFromRenderer } = await import('./tab-content-request-relay')
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const mainWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
  const pending = requestTabContentFromRenderer(mainWindow as never, {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    expectSource: { kind: 'terminal', terminalId: 'tab-1' },
    content: { kind: 'agent-session', sessionId: 'session-1', agent: 'codex' },
    focus: false
  })
  const request = webContents.send.mock.calls[0]?.[1] as { expiresAt: number }
  // The window refuses at the deadline, so main waits a little past it.
  expect(request.expiresAt).toBe(11_000)
  const refused = expect(pending).rejects.toBeInstanceOf(TerminalNotPlacedError)
  await vi.advanceTimersByTimeAsync(request.expiresAt - Date.now() + 2_000)
  await refused
  expect(ipcEmitter.listenerCount('ui:tabContentReply')).toBe(0)
  vi.useRealTimers()
})
