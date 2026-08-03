import { describe, expect, it, vi } from 'vitest'
import { BrowserActionRecorder } from './browser-action-recorder'
import { BROWSER_RECORDER_ACTION_CHANNEL } from '../../shared/browser-recorder-automation'

describe('BrowserActionRecorder session observer', () => {
  function makeObserverHarness() {
    const evaluate = vi.fn()
    const getPageInfo = vi.fn()
    const getPageWebContents = vi.fn()
    const captureStart = vi.fn()
    const captureStop = vi.fn()
    const networkLog = vi.fn()
    const send = vi.fn()
    const bridge = {
      evaluate,
      getPageInfo,
      getPageWebContents,
      captureStart,
      captureStop,
      networkLog
    }
    const consoleListeners = new Map<string, (details: unknown) => void>()
    const webContents = {
      on: vi.fn((event: string, handler: (details: unknown) => void) => {
        consoleListeners.set(event, handler)
      }),
      removeListener: vi.fn((event: string) => {
        consoleListeners.delete(event)
      })
    }
    const windowLike = { webContents: { send } }
    const recorder = new BrowserActionRecorder()
    const pageInfo = { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' }
    getPageInfo.mockReturnValue(pageInfo)
    getPageWebContents.mockReturnValue(webContents)
    const enable = () =>
      recorder.setEnabled(
        true,
        { worktreeId: 'wt-1', browserPageId: 'page-1' },
        {
          getBridge: () => bridge as never,
          getWindow: () => windowLike as never
        }
      )
    const fireConsole = (message: string, level = 'info') =>
      consoleListeners.get('console-message')?.({
        level,
        message,
        lineNumber: 3,
        sourceId: 'a.js'
      } as never)
    return {
      recorder,
      bridge,
      webContents,
      send,
      evaluate,
      getPageWebContents,
      captureStart,
      captureStop,
      networkLog,
      enable,
      fireConsole
    }
  }

  it('attaches the page listener, injects the capture script, and starts HAR on enable', () => {
    const { recorder, webContents, evaluate, captureStart, enable } = makeObserverHarness()
    enable()
    expect(webContents.on).toHaveBeenCalledWith('console-message', expect.any(Function))
    expect(evaluate).toHaveBeenCalledWith(
      expect.stringContaining('__orca_recorder__'),
      'wt-1',
      'page-1'
    )
    expect(captureStart).toHaveBeenCalledWith('wt-1', 'page-1')
    recorder.setEnabled(false)
  })

  it('turns tagged console lines into interaction events', async () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    fireConsole(
      `__orca_recorder__ ${JSON.stringify({ type: 'click', x: 340, y: 215, target: '#login-btn', tagName: 'button' })}`
    )
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, event] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(channel).toBe(BROWSER_RECORDER_ACTION_CHANNEL)
    expect(event).toMatchObject({
      kind: 'interaction',
      interaction: {
        kind: 'click',
        x: 340,
        y: 215,
        target: '#login-btn',
        tagName: 'button',
        page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' }
      }
    })
    recorder.setEnabled(false)
  })

  it('turns untagged console lines into console entries', () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    fireConsole('Uncaught TypeError: x is not a function', 'error')
    expect(send).toHaveBeenCalledTimes(1)
    const [, event] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(event).toMatchObject({
      kind: 'console',
      entry: {
        level: 'error',
        message: 'Uncaught TypeError: x is not a function',
        source: 'a.js',
        lineNumber: 3
      }
    })
    recorder.setEnabled(false)
  })

  it('caps console entries and warns once when the cap is reached', () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    for (let index = 0; index < 102; index += 1) {
      fireConsole(`message-${index}`)
    }
    const consoleEvents = send.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown>).kind === 'console'
    )
    // 100 entries + 1 cap warning
    expect(consoleEvents).toHaveLength(101)
    const capWarnings = consoleEvents.filter((call) =>
      ((call[1] as Record<string, unknown>).entry as { message: string }).message.includes(
        'cap reached'
      )
    )
    expect(capWarnings).toHaveLength(1)
    recorder.setEnabled(false)
  })

  it('re-attaches the listener and capture script after a navigation action', async () => {
    const { recorder, bridge, getPageWebContents, evaluate, enable } = makeObserverHarness()
    enable()
    const secondWebContents = { on: vi.fn(), removeListener: vi.fn() }
    getPageWebContents.mockReturnValue(secondWebContents)
    evaluate.mockResolvedValue({ result: '{}', origin: 'https://example.com/a' })

    await recorder.capture({
      method: 'browser.goto',
      params: { url: 'https://example.com/b' },
      worktreeId: 'wt-1',
      browserPageId: 'page-1',
      getBridge: () => bridge as never,
      getWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      run: async () => ({})
    })

    expect(secondWebContents.on).toHaveBeenCalledWith('console-message', expect.any(Function))
    // capture script re-injected into the new page
    expect(evaluate).toHaveBeenCalledWith(
      expect.stringContaining('__orca_recorder__'),
      'wt-1',
      'page-1'
    )
    recorder.setEnabled(false)
  })

  it('emits a network summary and detaches the listener on disable', async () => {
    const { recorder, webContents, networkLog, send, enable } = makeObserverHarness()
    networkLog.mockResolvedValue({
      entries: [
        {
          url: 'https://example.com/a',
          method: 'GET',
          status: 200,
          mimeType: 'text/html',
          size: 100,
          timestamp: 1
        },
        {
          url: 'https://example.com/x',
          method: 'GET',
          status: 404,
          mimeType: 'text/html',
          size: 50,
          timestamp: 2
        }
      ],
      truncated: false
    })
    enable()
    recorder.setEnabled(false)
    await vi.waitFor(() => {
      expect(
        send.mock.calls.some(
          (call) => (call[1] as Record<string, unknown>).kind === 'network-summary'
        )
      ).toBe(true)
    })
    expect(webContents.removeListener).toHaveBeenCalledWith('console-message', expect.any(Function))
    const [, event] = send.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>).kind === 'network-summary'
    ) as [string, Record<string, unknown>]
    expect(event).toMatchObject({
      kind: 'network-summary',
      summary: {
        total: 2,
        failed: 1,
        totalBytes: 150,
        byStatus: [
          { status: 200, count: 1 },
          { status: 404, count: 1 }
        ]
      }
    })
  })
})
