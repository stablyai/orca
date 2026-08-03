import { describe, expect, it, vi } from 'vitest'
import {
  BrowserActionRecorder,
  extractBrowserActionTarget,
  isFullyRedactedBrowserMethod,
  isRecordedBrowserMethod,
  sanitizeBrowserActionParams
} from './browser-action-recorder'
import { BROWSER_RECORDER_ACTION_CHANNEL } from '../../shared/browser-recorder-automation'

function makeFingerprintResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: 'https://example.com/login',
    title: 'Login',
    textLength: 120,
    interactive: 14,
    inputsDetail: [{ label: 'email', value: 'user@example.com' }],
    ...overrides
  })
}

function makeHarness() {
  const evaluate = vi.fn()
  const getPageInfo = vi.fn()
  const send = vi.fn()
  const webContents = {
    id: 1,
    session: { webRequest: { onCompleted: vi.fn() } },
    mainFrame: { executeJavaScript: vi.fn(() => Promise.resolve('installed')), frames: [] },
    on: vi.fn(),
    removeListener: vi.fn()
  }
  const getPageWebContents = vi.fn(() => webContents)
  const captureStart = vi.fn()
  const captureStop = vi.fn()
  const bridge = { evaluate, getPageInfo, getPageWebContents, captureStart, captureStop }
  const windowLike = { webContents: { send } }
  return {
    recorder: new BrowserActionRecorder(),
    bridge,
    windowLike,
    evaluate,
    getPageInfo,
    getPageWebContents,
    send
  }
}

describe('isRecordedBrowserMethod / isFullyRedactedBrowserMethod', () => {
  it('classifies interactive actions as recorded and probes as not', () => {
    expect(isRecordedBrowserMethod('browser.click')).toBe(true)
    expect(isRecordedBrowserMethod('browser.type')).toBe(true)
    expect(isRecordedBrowserMethod('browser.goto')).toBe(true)
    expect(isRecordedBrowserMethod('browser.mouseClick')).toBe(true)
    expect(isRecordedBrowserMethod('browser.snapshot')).toBe(false)
    expect(isRecordedBrowserMethod('browser.screenshot')).toBe(false)
  })

  it('fully redacts credential-bearing methods', () => {
    expect(isFullyRedactedBrowserMethod('browser.clipboardWrite')).toBe(true)
    expect(isFullyRedactedBrowserMethod('browser.setCredentials')).toBe(true)
    expect(isFullyRedactedBrowserMethod('browser.click')).toBe(false)
  })
})

describe('sanitizeBrowserActionParams', () => {
  it('keeps scalar params and drops routing metadata', () => {
    const out = sanitizeBrowserActionParams('browser.click', {
      element: '#submit',
      worktree: 'repo::path',
      page: 'page-1'
    })
    expect(out).toEqual({ element: '#submit' })
  })

  it('caps long string values', () => {
    const long = 'x'.repeat(500)
    const out = sanitizeBrowserActionParams('browser.fill', { element: '#a', value: long })
    expect(out.value).toBe(`${'x'.repeat(200)}…`)
  })

  it('drops secret-shaped params', () => {
    const out = sanitizeBrowserActionParams('browser.fill', {
      element: '#a',
      value: 'hello',
      password: 'hunter2'
    })
    expect(out).toEqual({ element: '#a', value: 'hello' })
  })

  it('redacts whole payloads for credential methods', () => {
    const out = sanitizeBrowserActionParams('browser.clipboardWrite', { text: 'secret' })
    expect(out).toEqual({ redacted: true })
  })

  it('joins and caps array params', () => {
    const out = sanitizeBrowserActionParams('browser.upload', {
      element: 'input[type=file]',
      files: ['/a.png', '/b.png', 3 as unknown as string]
    })
    expect(out.files).toBe('/a.png, /b.png, 3')
  })
})

describe('extractBrowserActionTarget', () => {
  it('maps element refs, selectors, coordinates, and urls', () => {
    expect(extractBrowserActionTarget({ element: '@e5' })).toEqual({
      kind: 'ref',
      value: '@e5'
    })
    expect(extractBrowserActionTarget({ element: 'button[type=submit]' })).toEqual({
      kind: 'selector',
      value: 'button[type=submit]'
    })
    expect(extractBrowserActionTarget({ x: 12.4, y: 88.9 })).toEqual({
      kind: 'coordinate',
      value: '12,89'
    })
    expect(extractBrowserActionTarget({ url: 'https://example.com' })).toEqual({
      kind: 'url',
      value: 'https://example.com'
    })
    expect(extractBrowserActionTarget({})).toEqual({ kind: 'none', value: '' })
  })
})

describe('BrowserActionRecorder.capture', () => {
  it('bypasses all recording when disabled', async () => {
    const { recorder, bridge, windowLike, evaluate, getPageInfo, send } = makeHarness()
    const run = vi.fn(async () => 'result')

    const result = await recorder.capture({
      method: 'browser.click',
      params: { element: '#a' },
      getBridge: () => bridge as never,
      getWindow: () => windowLike as never,
      run
    })

    expect(result).toBe('result')
    expect(run).toHaveBeenCalledTimes(1)
    expect(evaluate).not.toHaveBeenCalled()
    expect(getPageInfo).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('records the action with before/after fingerprints and a DOM diff', async () => {
    const { recorder, bridge, windowLike, evaluate, getPageInfo, send } = makeHarness()
    getPageInfo.mockReturnValue({
      browserPageId: 'page-1',
      url: 'https://example.com/login',
      title: 'Login'
    })
    evaluate
      .mockResolvedValueOnce({
        result: makeFingerprintResult(),
        origin: 'https://example.com/login'
      })
      .mockResolvedValueOnce({
        result: makeFingerprintResult({
          url: 'https://example.com/dashboard',
          title: 'Dashboard',
          textLength: 400,
          inputsDetail: []
        }),
        origin: 'https://example.com/dashboard'
      })
    recorder.setEnabled(
      true,
      { worktreeId: 'wt-1', browserPageId: 'page-1' },
      { getBridge: () => bridge as never, getWindow: () => windowLike as never }
    )
    const run = vi.fn(async () => ({ ok: true }))

    const result = await recorder.capture({
      method: 'browser.click',
      params: { element: '#login-btn' },
      worktreeId: 'wt-1',
      browserPageId: 'page-1',
      getBridge: () => bridge as never,
      getWindow: () => windowLike as never,
      run
    })

    expect(result).toEqual({ ok: true })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, event] = send.mock.calls[0] as [
      string,
      { kind: string; action: Record<string, unknown> }
    ]
    expect(channel).toBe(BROWSER_RECORDER_ACTION_CHANNEL)
    expect(event.kind).toBe('action')
    expect(event.action).toMatchObject({
      method: 'browser.click',
      target: { kind: 'selector', value: '#login-btn' },
      params: { element: '#login-btn' },
      page: { browserPageId: 'page-1', url: 'https://example.com/login', title: 'Login' },
      ok: true,
      error: null,
      urlAfter: 'https://example.com/dashboard',
      titleAfter: 'Dashboard',
      domDiff: {
        urlChanged: true,
        titleChanged: true,
        textLengthDelta: 280,
        interactiveDelta: 0,
        inputsChanged: true,
        inputChanges: [{ label: 'email', before: 'user@example.com', after: '' }],
        changed: ['url', 'title', 'text', 'inputs']
      }
    })
    recorder.setEnabled(false)
  })

  it('re-throws the action error and records it', async () => {
    const { recorder, bridge, windowLike, evaluate, send } = makeHarness()
    evaluate.mockResolvedValue({ result: makeFingerprintResult(), origin: 'x' })
    recorder.setEnabled(
      true,
      { worktreeId: 'wt-1', browserPageId: 'page-1' },
      { getBridge: () => bridge as never, getWindow: () => windowLike as never }
    )
    const failure = new Error('element not found: #missing')

    await expect(
      recorder.capture({
        method: 'browser.click',
        params: { element: '#missing' },
        getBridge: () => bridge as never,
        getWindow: () => windowLike as never,
        run: async () => {
          throw failure
        }
      })
    ).rejects.toThrow('element not found: #missing')

    expect(send).toHaveBeenCalledTimes(1)
    const [, event] = send.mock.calls[0] as [
      string,
      { kind: string; action: Record<string, unknown> }
    ]
    expect(event.action.ok).toBe(false)
    expect(event.action.error).toBe('element not found: #missing')
    // Why: both fingerprints succeed (same page state), so the diff is empty, not null.
    expect(event.action.domDiff).toEqual({
      urlChanged: false,
      titleChanged: false,
      textLengthDelta: 0,
      interactiveDelta: 0,
      inputsChanged: false,
      inputChanges: [],
      changed: []
    })
    recorder.setEnabled(false)
  })

  it('tolerates fingerprint failures and still reports the action', async () => {
    const { recorder, bridge, windowLike, evaluate, send } = makeHarness()
    evaluate.mockRejectedValue(new Error('debugger busy'))
    recorder.setEnabled(
      true,
      { worktreeId: 'wt-1', browserPageId: 'page-1' },
      { getBridge: () => bridge as never, getWindow: () => windowLike as never }
    )

    await recorder.capture({
      method: 'browser.goto',
      params: { url: 'https://example.com' },
      getBridge: () => bridge as never,
      getWindow: () => windowLike as never,
      run: async () => ({ url: 'https://example.com', title: 'X' })
    })

    expect(send).toHaveBeenCalledTimes(1)
    const [, event] = send.mock.calls[0] as [
      string,
      { kind: string; action: Record<string, unknown> }
    ]
    expect(event.action.ok).toBe(true)
    expect(event.action.domDiff).toBeNull()
    recorder.setEnabled(false)
  })
})
