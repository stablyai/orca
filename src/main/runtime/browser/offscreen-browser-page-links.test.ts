import { describe, expect, it, vi } from 'vitest'
import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from '../../browser/browser-guest-input-gesture'
import { OffscreenBrowserPageLinks } from './offscreen-browser-page-links'

const desktop = { pairedDeviceId: 'desk-1', clientKind: 'runtime' } as const
const link = {
  openerPageId: 'page-1',
  worktreeId: 'wt-1',
  profileId: 'work',
  url: 'https://example.com/',
  activate: true
}

function setup() {
  let now = 1_000
  const browserTabCreate = vi.fn(async () => ({ browserPageId: 'opened' }))
  const links = new OffscreenBrowserPageLinks(browserTabCreate, () => now)
  return { links, browserTabCreate, advance: (ms: number) => (now += ms) }
}

const tab = { url: link.url, worktree: 'id:wt-1', profileId: 'work' }

describe('OffscreenBrowserPageLinks', () => {
  it('brings the tab to the front only for the client that clicked, once', () => {
    const { links, browserTabCreate } = setup()
    links.noteInput('page-1', desktop)

    links.open(link)
    links.open(link)

    expect(browserTabCreate.mock.calls).toEqual([
      [
        { ...tab, activate: true },
        { ...desktop, follows: true }
      ],
      [{ ...tab, activate: false }, undefined]
    ])
  })

  it('moves no view when no paired client recently pressed on that page', () => {
    const { links, browserTabCreate, advance } = setup()
    links.noteInput('page-1', {})
    links.noteInput('page-2', desktop)
    links.open(link)

    links.noteInput('page-1', desktop)
    advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS + 1)
    links.open(link)

    expect(browserTabCreate.mock.calls).toEqual([
      [{ ...tab, activate: false }, undefined],
      [{ ...tab, activate: false }, undefined]
    ])
  })
})
