import { describe, expect, it, vi } from 'vitest'
import { BrowserActionRecorder } from './browser-action-recorder'
import {
  parseBrowserInteractionMessage,
  parseBrowserRequestMessage,
  redactPostData,
  redactRequestUrl
} from './browser-recorder-message-parsing'
import { BROWSER_RECORDER_ACTION_CHANNEL } from '../../shared/browser-recorder-automation'

describe('recorder message parsers', () => {
  it('parses typing bursts, keys, hovers, and requests from tagged lines', () => {
    expect(
      parseBrowserInteractionMessage(
        `__orca_recorder__ ${JSON.stringify({ type: 'type', text: 'ABC', target: '#stok_kod' })}`
      )
    ).toEqual({ type: 'type', text: 'ABC', target: '#stok_kod' })
    expect(
      parseBrowserInteractionMessage(
        `__orca_recorder__ ${JSON.stringify({ type: 'keydown', key: 'Enter', target: '#a' })}`
      )
    ).toEqual({ type: 'keydown', key: 'Enter', target: '#a' })
    expect(
      parseBrowserInteractionMessage(
        `__orca_recorder__ ${JSON.stringify({ type: 'hover', target: '#menu-stok' })}`
      )
    ).toEqual({ type: 'hover', target: '#menu-stok' })
    expect(parseBrowserInteractionMessage('__orca_recorder__ not-json')).toBeNull()
  })

  it('routes request lines to the request parser only', () => {
    const line = `__orca_recorder__ ${JSON.stringify({ type: 'request', method: 'POST', url: 'https://x/a', status: 200 })}`
    expect(parseBrowserInteractionMessage(line)).toBeNull()
    expect(parseBrowserRequestMessage(line)).toMatchObject({
      type: 'request',
      method: 'POST',
      url: 'https://x/a',
      status: 200
    })
    expect(parseBrowserRequestMessage('console.log("plain")')).toBeNull()
  })

  it('redacts secret-shaped values in request URLs and bodies', () => {
    expect(redactRequestUrl('https://x/api?islem=stok&key=abc123')).toBe(
      'https://x/api?islem=stok&key=***'
    )
    expect(redactPostData('islem=stok_kaydet&sifre=hunter2&ad=Test', 500)).toBe(
      'islem=stok_kaydet&sifre=***&ad=Test'
    )
    expect(redactPostData('k=v'.repeat(200), 20)).toMatch(/…$/)
  })
})

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
    expect(webContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function))
    expect(evaluate).toHaveBeenCalledWith(
      expect.stringContaining('__orca_recorder__'),
      'wt-1',
      'page-1'
    )
    expect(captureStart).toHaveBeenCalledWith('wt-1', 'page-1')
    recorder.setEnabled(false)
  })

  it('turns a typing burst into a single type interaction', () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    fireConsole(
      `__orca_recorder__ ${JSON.stringify({ type: 'type', text: 'ABC123', target: '#stok_kod' })}`
    )
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, event] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(channel).toBe(BROWSER_RECORDER_ACTION_CHANNEL)
    expect(event).toMatchObject({
      kind: 'interaction',
      interaction: {
        kind: 'type',
        text: 'ABC123',
        target: '#stok_kod',
        page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' }
      }
    })
    recorder.setEnabled(false)
  })

  it('turns untagged console lines into coalesced console entries', () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    fireConsole('same message', 'error')
    fireConsole('same message', 'error')
    fireConsole('same message', 'error')
    fireConsole('different message')
    expect(send).toHaveBeenCalledTimes(1)
    const [, event] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(event).toMatchObject({
      kind: 'console',
      entry: {
        level: 'error',
        message: 'same message',
        repeatCount: 3
      }
    })
    recorder.setEnabled(false)
  })

  it('turns tagged request lines into network-request events with redaction', async () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    fireConsole(
      `__orca_recorder__ ${JSON.stringify({
        type: 'request',
        method: 'POST',
        url: 'https://example.com/api/stok?key=abc',
        body: 'islem=stok_kaydet&sifre=hunter2',
        status: 200,
        durationMs: 85
      })}`
    )
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1)
    })
    const [, event] = send.mock.calls[0] as [string, Record<string, unknown>]
    expect(event).toMatchObject({
      kind: 'network-request',
      request: {
        method: 'POST',
        url: 'https://example.com/api/stok?key=***',
        postData: 'islem=stok_kaydet&sifre=***',
        status: 200,
        durationMs: 85
      }
    })
    recorder.setEnabled(false)
  })

  it('caps console entries and warns once when the cap is reached', () => {
    const { recorder, send, enable, fireConsole } = makeObserverHarness()
    enable()
    for (let index = 0; index < 130; index += 1) {
      fireConsole(`message-${index}`)
    }
    const consoleEvents = send.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown>).kind === 'console'
    )
    // 120 entries + 1 cap warning
    expect(consoleEvents).toHaveLength(121)
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
