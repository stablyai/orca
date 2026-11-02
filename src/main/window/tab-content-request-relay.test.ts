import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { TerminalRevealUnconfirmedError } from '../runtime/session-tabs/terminal-not-placed-error'

const ipcEmitter = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcEmitter.removeListener(channel, listener)
  }
}))

// A live page that never answers: the change is observed for a bounded time, then asked about
// read-only, then unknown (never a refusal), so the switch's command ends. A late answer is heard
// until the page navigates away, and nothing from the old page is taken after that.
it('takes a hung page as unknown in bounded time, and hears a late answer until the page ends', async () => {
  vi.useFakeTimers()
  const { requestTabContentFromRenderer } = await import('./tab-content-request-relay')
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const mainWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
  const late = vi.fn()
  const change = {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    expectSource: { kind: 'terminal', terminalId: 'tab-1' },
    content: { kind: 'agent-session', sessionId: 'session-1', agent: 'codex' },
    focus: false,
    operation: 'op-1',
    page: 'page-1'
  } as const
  const pending = requestTabContentFromRenderer(mainWindow as never, change, late)
  const unknown = expect(pending).rejects.toBeInstanceOf(TerminalRevealUnconfirmedError)
  await vi.advanceTimersByTimeAsync(20_000)
  await unknown
  const [first, status] = webContents.send.mock.calls.map(([, sent]) => sent)
  expect(first).toMatchObject({ operation: 'op-1', page: 'page-1' })
  expect(first).not.toHaveProperty('status')
  expect(status).toMatchObject({ operation: 'op-1', page: 'page-1', status: true })
  // The page answers at last: that answer still settles the switch.
  ipcEmitter.emit(
    'ui:tabContentReply',
    { sender: webContents },
    {
      requestId: (first as { requestId: string }).requestId,
      retargeted: true,
      tabId: 'tab-1',
      page: 'page-1'
    }
  )
  expect(late).toHaveBeenCalledExactlyOnceWith({ retargeted: true, tabId: 'tab-1', page: 'page-1' })
  expect(ipcEmitter.listenerCount('ui:tabContentReply')).toBe(0)

  // Another switch whose page reloads: unknown at once, and nothing that page sent counts after.
  const reloaded = requestTabContentFromRenderer(
    mainWindow as never,
    { ...change, operation: 'op-2' },
    late
  ).catch((error: unknown) => error)
  webContents.emit('did-start-navigation', {}, 'app://reload', false, true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await reloaded).toBeInstanceOf(TerminalRevealUnconfirmedError)
  for (const [, sent] of webContents.send.mock.calls.slice(2)) {
    ipcEmitter.emit(
      'ui:tabContentReply',
      { sender: webContents },
      {
        requestId: (sent as { requestId: string }).requestId,
        retargeted: true
      }
    )
  }
  expect(late).toHaveBeenCalledTimes(1)
  expect(ipcEmitter.listenerCount('ui:tabContentReply')).toBe(0)
  vi.useRealTimers()
})
