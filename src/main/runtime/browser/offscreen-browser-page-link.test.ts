import { describe, expect, it, vi } from 'vitest'
import { openOffscreenBrowserPageLink } from './offscreen-browser-page-link'

const link = { worktreeId: 'wt-1', profileId: 'work', url: 'https://example.com/' }
const tab = { url: link.url, worktree: 'id:wt-1', profileId: 'work' }

describe('openOffscreenBrowserPageLink', () => {
  it('brings the tab to the front only for the client whose foreground click opened it', () => {
    const browserTabCreate = vi.fn(async () => ({ browserPageId: 'opened' }))

    openOffscreenBrowserPageLink(browserTabCreate, {
      ...link,
      activate: true,
      pairedDeviceId: 'desk-1'
    })
    openOffscreenBrowserPageLink(browserTabCreate, {
      ...link,
      activate: false,
      pairedDeviceId: 'desk-1'
    })
    openOffscreenBrowserPageLink(browserTabCreate, {
      ...link,
      activate: true,
      pairedDeviceId: null
    })

    const behind = [{ ...tab, activate: false }, { opensPageLink: true }]
    expect(browserTabCreate.mock.calls).toEqual([
      [
        { ...tab, activate: true, navigation: 'caller' },
        { opensPageLink: true, pairedDeviceId: 'desk-1' }
      ],
      behind,
      behind
    ])
  })
})
