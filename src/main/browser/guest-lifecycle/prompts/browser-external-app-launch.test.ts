import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserPagePromptRequest } from '../../../../shared/browser/prompts/browser-page-prompt'

const { openExternalMock, agentInjecting } = vi.hoisted(() => ({
  openExternalMock: vi.fn(async () => {}),
  agentInjecting: { current: false }
}))

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: () => 'Visual Studio Code', getPath: () => '/tmp' },
  shell: { openExternal: openExternalMock }
}))

vi.mock('../../cdp/input/agent-input-injection', () => ({
  isAgentInjectingInput: () => agentInjecting.current
}))

import { trackBrowserGuestInputGesture } from '../input/browser-guest-input-gesture'
import {
  registerBrowserSessionSitePermissions,
  sessionBrowserSitePermissions
} from '../../site-settings/permissions/browser-site-permission-memory'
import { requestBrowserExternalAppLaunch } from './browser-external-app-launch'
import { BROWSER_PAGE_PROMPT_TIMEOUT_MS, respondToBrowserPagePrompt } from './browser-page-prompts'

type MockContents = Electron.WebContents & EventEmitter

const LINK = 'vscode://file/src/app.ts:12'
const guests: MockContents[] = []

function mockTab(pageUrl: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed and send.
  const renderer = new EventEmitter() as MockContents
  Object.assign(renderer, { id: 1, isDestroyed: () => false, send: vi.fn() })
  const session = {}
  registerBrowserSessionSitePermissions(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the memory is only keyed by session identity.
    session as Electron.Session,
    sessionBrowserSitePermissions(`partition-${guests.length}`)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launches read id, session, getURL, isDestroyed and input and lifecycle events.
  const guest = new EventEmitter() as MockContents
  Object.assign(guest, {
    id: 100 + guests.length,
    session,
    getURL: () => pageUrl,
    isDestroyed: () => false
  })
  guests.push(guest)
  trackBrowserGuestInputGesture(guest)
  const prompts = (): BrowserPagePromptRequest[] =>
    vi
      .mocked(renderer.send)
      .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
      .map(([, request]) => request)
  return {
    // An unnamed requester, like a link in a sandboxed srcdoc frame.
    openLink: ({ pageInitiated = true } = {}) =>
      requestBrowserExternalAppLaunch({
        requester: guest,
        target: { browserPageId: 'page-1', renderer },
        rawUrl: LINK,
        requestingUrl: () => null,
        pageInitiated
      }),
    click: ({ byAgent = false } = {}) => {
      agentInjecting.current = byAgent
      guest.emit('before-mouse-event', {}, { type: 'mouseDown' })
      agentInjecting.current = false
    },
    prompts,
    answerLatest: (answer: unknown) =>
      respondToBrowserPagePrompt(renderer, { requestId: prompts().at(-1)!.requestId, answer })
  }
}

describe('requestBrowserExternalAppLaunch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    openExternalMock.mockClear()
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    for (const guest of guests.splice(0)) {
      guest.emit('destroyed')
    }
    vi.useRealTimers()
  })

  it('opens the app unasked after Always, only once per click by the desktop user', async () => {
    const tab = mockTab('https://review.example.com/guide')

    tab.click()
    tab.openLink()
    // The app name is platform-dependent (Linux names none), so it is left out.
    expect(tab.prompts().at(-1)?.details).toMatchObject({
      scheme: 'vscode',
      origin: null,
      rememberSite: 'https://review.example.com'
    })
    await tab.answerLatest('always')
    expect(openExternalMock).toHaveBeenCalledTimes(1)

    // The click that raised the prompt was spent there.
    tab.openLink()
    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(tab.prompts()).toHaveLength(1)

    vi.advanceTimersByTime(200)
    tab.click()
    tab.openLink()
    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(tab.prompts()).toHaveLength(1)

    // The click's release cannot open a second app.
    tab.click()
    tab.openLink()
    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(tab.prompts()).toHaveLength(1)

    // An agent's click still asks, even right after the user's own launch.
    tab.click({ byAgent: true })
    tab.openLink()
    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(tab.prompts()).toHaveLength(2)
  })

  it('offers no Always for a plain http site', () => {
    const tab = mockTab('http://review.example.com/guide')

    tab.openLink()

    expect(tab.prompts().at(-1)?.details).toMatchObject({ rememberSite: null })
  })

  it('does not credit the tab when the browser itself loaded a link that redirects to an app', () => {
    const tab = mockTab('https://review.example.com/guide')

    tab.openLink({ pageInitiated: false })

    expect(tab.prompts().at(-1)?.details).toMatchObject({ origin: null, rememberSite: null })
  })
})
