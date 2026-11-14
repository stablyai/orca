import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolvePagePromptTarget: vi.fn()
}))

vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    resolvePagePromptTarget: mocks.resolvePagePromptTarget
  }
}))

import type { BrowserPagePromptRequest } from '../../../../shared/browser/prompts/browser-page-prompt'
import type { BrowserSitePermission } from '../../../../shared/browser-site-permission'
import {
  BROWSER_PAGE_PROMPT_TIMEOUT_MS,
  respondToBrowserPagePrompt
} from '../../guest-lifecycle/prompts/browser-page-prompts'
import { decideBrowserSitePermissions } from './browser-site-permission-prompt'
import {
  savedBrowserSitePermissions,
  type BrowserSitePermissionMemory
} from './browser-site-permission-memory'
import { configureBrowserSitePermissionStore } from './browser-site-permission-store'

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
})
