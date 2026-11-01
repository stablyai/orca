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
const tab = { url: link.url, worktree: 'id:wt-1', profileId: 'work' }
const front = [
  { ...tab, activate: true },
  { ...desktop, follows: true }
]
const behind = [{ ...tab, activate: false }, { leavesAgentTab: true }]

function setup() {
  let now = 1_000
  const browserTabCreate = vi.fn(async () => ({ browserPageId: 'opened' }))
  const links = new OffscreenBrowserPageLinks(browserTabCreate, () => now)
  const click = (caller: { pairedDeviceId?: string; clientKind?: 'runtime' }, page = 'page-1') =>
    links.deliverInput(page, caller, async () => undefined)
  return { links, browserTabCreate, click, advance: (ms: number) => (now += ms) }
}

describe('OffscreenBrowserPageLinks', () => {
  it('brings the tab to the front only for the client that clicked, once', async () => {
    const { links, browserTabCreate, click } = setup()
    await click(desktop)

    links.open(link)
    links.open(link)

    expect(browserTabCreate.mock.calls).toEqual([front, behind])
  })

  it('keeps a queued click its client until delivery settles', async () => {
    const { links, browserTabCreate, advance } = setup()
    let deliver = (): void => {}
    const delivering = links.deliverInput(
      'page-1',
      desktop,
      () => new Promise<void>((resolve) => (deliver = resolve))
    )

    advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS * 5)
    links.open(link)
    deliver()
    await delivering

    expect(browserTabCreate.mock.calls).toEqual([front])
  })

  it('moves no view for links no paired client recently pressed on', async () => {
    const { links, browserTabCreate, click, advance } = setup()
    await click(desktop, 'page-2')
    links.open(link)

    await click(desktop)
    await click({})
    links.open(link)

    await click(desktop)
    advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS + 1)
    links.open(link)

    expect(browserTabCreate.mock.calls).toEqual([behind, behind, behind])
  })
})
