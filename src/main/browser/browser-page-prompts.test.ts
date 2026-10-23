import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserPagePromptRequest } from '../../shared/browser-page-prompt'
import {
  BROWSER_PAGE_PROMPT_TIMEOUT_MS,
  cancelBrowserPagePrompts,
  openBrowserPagePrompt,
  respondToBrowserPagePrompt,
  showBrowserPagePromptsAwaitingRegistration,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

type MockGuest = Electron.WebContents & EventEmitter

const guests: MockGuest[] = []
const targets = new Map<number, BrowserPagePromptTarget>()

/** The Orca window; prompts only read its id, liveness, send and its destroyed or crash events. */
function mockRenderer(id: number): MockGuest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed, send and the destroyed and crash events.
  const renderer = new EventEmitter() as MockGuest
  Object.assign(renderer, { id, isDestroyed: () => false, send: vi.fn() })
  return renderer
}

/** A page in a tab shown by `renderer`; only its id, liveness and events matter to prompts. */
function mockGuest(
  renderer: Electron.WebContents,
  browserPageId: string,
  { registered = true } = {}
): MockGuest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed and the input, navigation and destroyed events.
  const guest = new EventEmitter() as MockGuest
  Object.assign(guest, { id: 100 + guests.length, isDestroyed: () => false })
  guests.push(guest)
  targets.set(guest.id, registered ? { browserPageId, renderer } : 'awaiting-registration')
  return guest
}

function ask(guest: Electron.WebContents, coalesceKey?: string) {
  const settle = vi.fn()
  const opening = openBrowserPagePrompt({
    kind: 'external-app',
    requester: guest,
    target: targets.get(guest.id) ?? null,
    details: () => ({ appName: 'Zoom', scheme: 'zoommtg', origin: 'https://zoom.us' }),
    coalesceKey,
    parseAnswer: (value) => (value === true ? true : undefined),
    settle
  })
  return { opening, settle }
}

function sentRequests(renderer: Electron.WebContents): BrowserPagePromptRequest[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    .map(([, request]) => request)
}

function closedRequestIds(renderer: Electron.WebContents): string[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-closed')
    .map(([, event]) => event.requestId)
}

const latestId = (renderer: Electron.WebContents): string =>
  sentRequests(renderer).at(-1)!.requestId

describe('browser page prompts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    for (const guest of guests.splice(0)) {
      guest.emit('destroyed')
    }
    targets.clear()
    vi.useRealTimers()
  })

  it('asks the window showing the page and takes one valid answer, from that window only', async () => {
    const renderer = mockRenderer(10)
    const { opening, settle } = ask(mockGuest(renderer, 'page-1'))

    expect(opening).toBe('prompting')
    expect(sentRequests(renderer)).toEqual([
      {
        requestId: expect.any(String),
        kind: 'external-app',
        details: { appName: 'Zoom', scheme: 'zoommtg', origin: 'https://zoom.us' }
      }
    ])
    const requestId = latestId(renderer)
    const answer = (sender: Electron.WebContents, value: unknown) =>
      respondToBrowserPagePrompt(sender, { requestId, answer: value })

    await expect(answer(mockRenderer(11), true)).resolves.toBe('rejected')
    await expect(answer(renderer, 'yes')).resolves.toBe('rejected')
    expect(settle).not.toHaveBeenCalled()
    await expect(answer(renderer, true)).resolves.toBe('answered')
    await expect(answer(renderer, true)).resolves.toBe('rejected')
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(true)
  })

  it('refuses a page with no window on this machine', () => {
    const renderer = mockRenderer(10)
    const streamed = mockGuest(renderer, 'page-1')
    targets.delete(streamed.id)

    const { opening, settle } = ask(streamed)

    expect(opening).toBe('no-window')
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    expect(settle).not.toHaveBeenCalled()
  })

  it("holds a new tab's question until its window registers it, and drops it if none does", () => {
    const renderer = mockRenderer(10)
    const newTab = mockGuest(renderer, 'page-1', { registered: false })
    const orphan = mockGuest(renderer, 'page-2', { registered: false })
    const shown = ask(newTab)
    const dropped = ask(orphan)
    expect([shown.opening, dropped.opening]).toEqual(['prompting', 'prompting'])
    expect(sentRequests(renderer)).toEqual([])

    showBrowserPagePromptsAwaitingRegistration(newTab.id, { browserPageId: 'page-1', renderer })
    showBrowserPagePromptsAwaitingRegistration(orphan.id, null)

    expect(sentRequests(renderer)).toHaveLength(1)
    expect(dropped.settle).toHaveBeenCalledWith(null)
    expect(shown.settle).not.toHaveBeenCalled()
  })

  it('keeps one prompt per page, sharing it only with a request under the same key', async () => {
    const renderer = mockRenderer(10)
    const guest = mockGuest(renderer, 'page-1')
    const first = ask(guest, 'realm-a')
    const sameKey = ask(guest, 'realm-a')
    const otherKey = ask(guest, 'realm-b')
    const noKey = ask(guest)
    const otherPage = ask(mockGuest(renderer, 'page-2'))

    expect([first, sameKey, otherKey, noKey, otherPage].map((r) => r.opening)).toEqual([
      'prompting',
      'prompting',
      'refused',
      'refused',
      'prompting'
    ])
    expect(sentRequests(renderer)).toHaveLength(2)
    await respondToBrowserPagePrompt(renderer, {
      requestId: sentRequests(renderer)[0].requestId,
      answer: true
    })
    expect(first.settle).toHaveBeenCalledWith(true)
    expect(sameKey.settle).toHaveBeenCalledWith(true)
    expect(otherPage.settle).not.toHaveBeenCalled()
  })

  it('keeps a page quiet after a decline or an ignored prompt, until the user acts on it', async () => {
    const renderer = mockRenderer(10)
    const guest = mockGuest(renderer, 'page-1')

    const declined = ask(guest)
    await respondToBrowserPagePrompt(renderer, { requestId: latestId(renderer), answer: null })
    expect(declined.settle).toHaveBeenCalledWith(null)

    // The page reloading itself, or a pointer move, is not the user acting.
    guest.emit('did-start-navigation', { isMainFrame: true, initiator: {} })
    guest.emit('input-event', {}, { type: 'mouseMove' })
    expect(ask(guest).opening).toBe('refused')
    // Reload from Orca's toolbar: no frame started it.
    guest.emit('did-start-navigation', { isMainFrame: true, initiator: null })
    expect(ask(guest).opening).toBe('prompting')

    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    expect(ask(guest).opening).toBe('refused')
    guest.emit('input-event', {}, { type: 'mouseDown' })
    expect(ask(guest).opening).toBe('prompting')

    // Saying yes never quiets the page.
    await respondToBrowserPagePrompt(renderer, { requestId: latestId(renderer), answer: true })
    expect(ask(guest).opening).toBe('prompting')
  })

  it('closes the prompt with a null answer when it expires or its page goes away', async () => {
    const renderer = mockRenderer(10)
    const expiring = ask(mockGuest(renderer, 'page-1'))
    const expiringId = latestId(renderer)
    const closingGuest = mockGuest(renderer, 'page-2')
    const closing = ask(closingGuest)
    const closingId = latestId(renderer)

    cancelBrowserPagePrompts('page-2')
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    await Promise.resolve()

    expect(closedRequestIds(renderer)).toEqual([closingId, expiringId])
    expect(expiring.settle).toHaveBeenCalledWith(null)
    expect(closing.settle).toHaveBeenCalledWith(null)
    await expect(
      respondToBrowserPagePrompt(renderer, { requestId: closingId, answer: true })
    ).resolves.toBe('rejected')
    // A closed page is not quieted: it never declined anything.
    expect(ask(closingGuest).opening).toBe('prompting')
  })

  it.each([
    ['navigates to a new document', 'did-navigate'],
    ['closes, as a popup does', 'destroyed'],
    ['crashes', 'render-process-gone']
  ])('closes the prompt when the page that asked %s', async (_name, event) => {
    const renderer = mockRenderer(10)
    const guest = mockGuest(renderer, 'page-1')
    const { settle } = ask(guest)
    const requestId = latestId(renderer)

    guest.emit(event)

    expect(closedRequestIds(renderer)).toEqual([requestId])
    expect(settle).toHaveBeenCalledWith(null)
    await expect(respondToBrowserPagePrompt(renderer, { requestId, answer: true })).resolves.toBe(
      'rejected'
    )
    // The page's next question gets its own prompt instead of waiting on the dead one.
    expect(ask(guest).opening).toBe('prompting')
  })

  it('closes the prompt when the window that was asked closes or crashes', () => {
    const renderer = mockRenderer(10)
    const { settle } = ask(mockGuest(renderer, 'page-1'))

    renderer.emit('render-process-gone')

    expect(settle).toHaveBeenCalledWith(null)
  })

  it('stops watching the page once its prompt is answered', async () => {
    const renderer = mockRenderer(10)
    const guest = mockGuest(renderer, 'page-1')
    ask(guest)

    await respondToBrowserPagePrompt(renderer, { requestId: latestId(renderer), answer: true })

    const watched = ['did-navigate', 'destroyed', 'render-process-gone']
    expect(watched.map((e) => guest.listenerCount(e) + renderer.listenerCount(e))).toEqual([
      0, 0, 0
    ])
  })

  it('reports a yes that could not be carried out', async () => {
    const renderer = mockRenderer(10)
    const guest = mockGuest(renderer, 'page-1')
    const failing = ask(guest)
    failing.settle.mockResolvedValue('failed')

    await expect(
      respondToBrowserPagePrompt(renderer, { requestId: latestId(renderer), answer: true })
    ).resolves.toBe('failed')
  })
})
