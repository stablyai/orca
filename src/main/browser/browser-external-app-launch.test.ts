import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getApplicationNameForProtocol: vi.fn((_url: string) => 'Okta Verify'),
  openExternal: vi.fn((_url: string) => Promise.resolve())
}))

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: mocks.getApplicationNameForProtocol },
  shell: { openExternal: mocks.openExternal }
}))

import type { BrowserPagePromptRequest } from '../../shared/browser-page-prompt'
import { requestBrowserExternalAppLaunch } from './browser-external-app-launch'
import {
  BROWSER_PAGE_PROMPT_TIMEOUT_MS,
  respondToBrowserPagePrompt,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

const OKTA_URL = 'com-okta-authenticator:/deviceChallenge?challengeRequest=abc'

function mockRenderer(id: number): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed, send and subscribe to the window's lifecycle events.
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  } as unknown as Electron.WebContents
}

const requesters: (Electron.WebContents & EventEmitter)[] = []

function mockRequester(): Electron.WebContents & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed and the input, navigation and destroyed events.
  const contents = new EventEmitter() as Electron.WebContents & EventEmitter
  Object.assign(contents, { id: 1000 + requesters.length, isDestroyed: () => false })
  requesters.push(contents)
  return contents
}

function ask(rawUrl = OKTA_URL, requestingUrl: string | null = 'https://acme.okta.com/signin') {
  return requestBrowserExternalAppLaunch({
    requester: mockRequester(),
    target: resolveTarget(),
    rawUrl,
    requestingUrl: () => requestingUrl
  })
}

function sentRequests(renderer: Electron.WebContents): BrowserPagePromptRequest[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    .map(([, request]) => request)
}

let resolveTarget: () => BrowserPagePromptTarget | null = () => null

describe('browser external app launch', () => {
  let renderer: Electron.WebContents

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.openExternal.mockClear()
    renderer = mockRenderer(10)
    // Give each request its own page to avoid prompt sharing.
    let page = 0
    resolveTarget = () => ({ browserPageId: `page-${++page}`, renderer })
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    for (const requester of requesters.splice(0)) {
      requester.emit('destroyed')
    }
    vi.useRealTimers()
  })

  it('names the app and the asking site, and opens the app only after a yes', async () => {
    expect(ask()).toBe(true)
    const [request] = sentRequests(renderer)
    expect(request).toEqual({
      requestId: expect.any(String),
      kind: 'external-app',
      details: {
        appName: process.platform === 'linux' ? null : 'Okta Verify',
        scheme: 'com-okta-authenticator',
        origin: 'https://acme.okta.com'
      }
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()

    await expect(
      respondToBrowserPagePrompt(renderer, { requestId: request.requestId, answer: true })
    ).resolves.toBe('answered')
    expect(mocks.openExternal).toHaveBeenCalledWith(OKTA_URL)

    ask('zoommtg://zoom.us/join?confno=1')
    await respondToBrowserPagePrompt(renderer, {
      requestId: sentRequests(renderer)[1].requestId,
      answer: null
    })
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://example.com/',
    'http://localhost:3000/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'blob:https://example.com/id',
    'about:blank',
    'orca-preview://doc/index.html',
    'shell:startup',
    'vbscript:msgbox(1)',
    'hcp://system/sysinfo',
    'ms-help://topic',
    'afp://share.example/volume',
    'not a url'
  ])('refuses %s without asking', (rawUrl) => {
    expect(ask(rawUrl)).toBe(false)
    expect(renderer.send).not.toHaveBeenCalled()
  })

  it('names no site when the asking frame is unknown', () => {
    ask(OKTA_URL, null)
    expect(sentRequests(renderer)[0].details).toMatchObject({ origin: null })
  })

  it('refuses a page with no window on this computer', () => {
    resolveTarget = () => null
    expect(ask()).toBe(false)
  })

  it('keeps blocking the link while its page already has a prompt open', () => {
    resolveTarget = () => ({ browserPageId: 'page-1', renderer })
    ask()
    expect(ask()).toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it('reports a launch the OS could not start, so the window can say so', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('no application for scheme'))
    ask('zoommtg://zoom.us/join?confno=1')

    await expect(
      respondToBrowserPagePrompt(renderer, {
        requestId: sentRequests(renderer)[0].requestId,
        answer: true
      })
    ).resolves.toBe('failed')
  })
})
