import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolvePagePromptTarget: vi.fn()
}))

vi.mock('./browser-manager', () => ({
  browserManager: {
    resolvePagePromptTarget: mocks.resolvePagePromptTarget
  }
}))

import type { BrowserPagePromptRequest } from '../../shared/browser-page-prompt'
import type { BrowserSitePermission } from '../../shared/browser-site-permission'
import { BROWSER_PAGE_PROMPT_TIMEOUT_MS, respondToBrowserPagePrompt } from './browser-page-prompts'
import {
  decideBrowserSitePermissions,
  isBrowserSitePermissionAllowed,
  savedBrowserSitePermissions,
  sessionBrowserSitePermissions,
  type BrowserSitePermissionMemory
} from './browser-site-permission-prompt'
import {
  configureBrowserSitePermissionStore,
  listBrowserSitePermissions
} from './browser-site-permission-store'

type MockGuest = Electron.WebContents & EventEmitter

const guests: MockGuest[] = []

function mockGuest(pageUrl = 'https://meet.example.com/room'): MockGuest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt only reads id, isDestroyed, getURL and the input, navigation and destroyed events.
  const guest = new EventEmitter() as MockGuest
  Object.assign(guest, {
    id: 100 + guests.length,
    isDestroyed: () => false,
    getURL: () => pageUrl
  })
  guests.push(guest)
  return guest
}

function mockRenderer(): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed, send and subscribe to the window's lifecycle events.
  return {
    id: 10,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  } as unknown as Electron.WebContents
}

function sentRequests(
  renderer: Electron.WebContents
): BrowserPagePromptRequest<'site-permission'>[] {
  return vi
    .mocked(renderer.send)
    .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
    .map(([, request]) => request)
}

let renderer: Electron.WebContents

function ask(
  permissions: BrowserSitePermission[],
  {
    memory = savedBrowserSitePermissions('default'),
    guest = mockGuest(),
    frameOrigin = guest.getURL()
  }: { memory?: BrowserSitePermissionMemory; guest?: MockGuest; frameOrigin?: string | null } = {}
): Promise<boolean> {
  return decideBrowserSitePermissions({ requester: guest, frameOrigin, memory, permissions })
}

function allowedOnCheck(
  permissions: BrowserSitePermission[],
  {
    memory = savedBrowserSitePermissions('default'),
    frameOrigin = 'https://meet.example.com'
  }: { memory?: BrowserSitePermissionMemory; frameOrigin?: string } = {}
): boolean {
  return isBrowserSitePermissionAllowed({
    source: { pageUrl: 'https://meet.example.com/room', frameOrigin },
    memory,
    permissions
  })
}

async function answerLatest(value: unknown): Promise<void> {
  const request = sentRequests(renderer).at(-1)
  if (!request) {
    throw new Error('Expected a prompt')
  }
  await respondToBrowserPagePrompt(renderer, {
    requestId: request.requestId,
    answer: value
  })
}

describe('browser site permission prompts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    renderer = mockRenderer()
    mocks.resolvePagePromptTarget.mockReset()
    mocks.resolvePagePromptTarget.mockReturnValue({
      browserPageId: 'page-1',
      renderer
    })
  })

  afterEach(() => {
    vi.advanceTimersByTime(BROWSER_PAGE_PROMPT_TIMEOUT_MS)
    for (const guest of guests.splice(0)) {
      guest.emit('destroyed')
    }
    vi.useRealTimers()
  })

  it('asks once for camera and microphone together, then remembers Allow', async () => {
    const call = ask(['camera', 'microphone'])
    expect(sentRequests(renderer)).toMatchObject([
      {
        kind: 'site-permission',
        details: {
          origin: 'https://meet.example.com',
          permissions: ['camera', 'microphone']
        }
      }
    ])
    await answerLatest('allow')
    await expect(call).resolves.toBe(true)

    await expect(ask(['camera'])).resolves.toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
    expect(allowedOnCheck(['camera', 'microphone'])).toBe(true)
  })

  it('remembers Block and refuses without asking again', async () => {
    const call = ask(['location'])
    await answerLatest('block')
    await expect(call).resolves.toBe(false)

    await expect(ask(['location'])).resolves.toBe(false)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it('asks only for what is unanswered, and a remembered Block refuses the whole request', async () => {
    const camera = ask(['camera'])
    await answerLatest('allow')
    await camera
    const both = ask(['camera', 'microphone'])
    expect(sentRequests(renderer).at(-1)?.details.permissions).toEqual(['microphone'])
    await answerLatest('block')
    await expect(both).resolves.toBe(false)

    await expect(ask(['camera', 'microphone'])).resolves.toBe(false)
    expect(sentRequests(renderer)).toHaveLength(2)
  })

  it('forgets a dismissed prompt, so the site is asked again later', async () => {
    const call = ask(['notifications'])
    await answerLatest(null)
    await expect(call).resolves.toBe(false)

    expect(listBrowserSitePermissions('default')).toEqual([])
    void ask(['notifications'])
    expect(sentRequests(renderer)).toHaveLength(2)
  })

  it('keeps each browser profile to its own answers', async () => {
    const call = ask(['clipboard'], { memory: savedBrowserSitePermissions('work') })
    await answerLatest('allow')
    await call

    void ask(['clipboard'], { memory: savedBrowserSitePermissions('default') })
    expect(sentRequests(renderer)).toHaveLength(2)
  })

  it("keeps a paired server's answers for its session only, where checks still see them", async () => {
    const pairedSession = sessionBrowserSitePermissions('persist:paired-a')
    const call = ask(['notifications'], { memory: pairedSession })
    await answerLatest('allow')
    await expect(call).resolves.toBe(true)

    expect(allowedOnCheck(['notifications'], { memory: pairedSession })).toBe(true)
    await expect(ask(['notifications'], { memory: pairedSession })).resolves.toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
    expect(listBrowserSitePermissions('default')).toEqual([])
    void ask(['notifications'], { memory: sessionBrowserSitePermissions('persist:paired-b') })
    expect(sentRequests(renderer)).toHaveLength(2)
  })

  it("gives a frame the tab's answers for what the tab delegates", async () => {
    const call = ask(['camera'])
    await answerLatest('allow')
    await call

    await expect(ask(['camera'], { frameOrigin: 'https://video.example.net' })).resolves.toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it("gives another site's frame only its own notification answer, and never asks for it", async () => {
    const tab = ask(['notifications'])
    await answerLatest('allow')
    await tab
    const widgetPage = ask(['notifications'], { guest: mockGuest('https://widget.example.net/') })
    await answerLatest('allow')
    await widgetPage

    expect(allowedOnCheck(['notifications'], { frameOrigin: 'https://widget.example.net' })).toBe(
      true
    )
    await expect(
      ask(['notifications'], { frameOrigin: 'https://widget.example.net' })
    ).resolves.toBe(true)
    expect(allowedOnCheck(['notifications'], { frameOrigin: 'https://ads.example.net' })).toBe(
      false
    )
    await expect(ask(['notifications'], { frameOrigin: 'https://ads.example.net' })).resolves.toBe(
      false
    )
    expect(sentRequests(renderer)).toHaveLength(2)
  })

  it('asks for a local file, and every local file shares the answer', async () => {
    const call = ask(['camera'], { guest: mockGuest('file:///Users/me/lab/permission-lab.html') })
    expect(sentRequests(renderer).at(-1)?.details.origin).toBe('file://')
    await answerLatest('allow')
    await expect(call).resolves.toBe(true)

    await expect(
      ask(['camera'], { guest: mockGuest('file:///Users/me/other/page.html') })
    ).resolves.toBe(true)
    expect(sentRequests(renderer)).toHaveLength(1)
  })

  it('refuses an opaque page without asking', async () => {
    await expect(ask(['camera'], { guest: mockGuest('data:text/html,<p>hi</p>') })).resolves.toBe(
      false
    )
    expect(sentRequests(renderer)).toEqual([])
  })

  it('refuses without asking when no window can show the question', async () => {
    mocks.resolvePagePromptTarget.mockReturnValue(null)

    await expect(ask(['camera'])).resolves.toBe(false)
    expect(sentRequests(renderer)).toEqual([])
  })

  it('remembers answers across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-site-permissions-'))
    configureBrowserSitePermissionStore(directory)
    const call = ask(['midi'])
    await answerLatest('allow')
    await call

    // Switch directories to evict the cache and verify the next read comes from disk.
    configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    expect(listBrowserSitePermissions('default')).toEqual([])
    configureBrowserSitePermissionStore(directory)
    expect(listBrowserSitePermissions('default')).toEqual([
      { origin: 'https://meet.example.com', decisions: { midi: 'allow' } }
    ])
  })
})
