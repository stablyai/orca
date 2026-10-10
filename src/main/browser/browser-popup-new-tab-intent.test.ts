import { describe, expect, it } from 'vitest'
import { isNewBrowserTabPopupIntent } from './browser-popup-new-tab-intent'

describe('isNewBrowserTabPopupIntent', () => {
  it.each([
    // target=_blank, window.open(url), and noopener/noreferrer opens all arrive unnamed as a tab.
    { frameName: '', disposition: 'foreground-tab', tab: true },
    // Cmd/Ctrl-click and middle-click.
    { frameName: '', disposition: 'background-tab', tab: true },
    // Size/position features and Shift-click.
    { frameName: '', disposition: 'new-window', tab: false },
    // A named open may use the returned handle, as OAuth does.
    { frameName: 'oauth', disposition: 'foreground-tab', tab: false },
    { frameName: 'oauth', disposition: 'new-window', tab: false },
    { frameName: '', disposition: 'other', tab: false }
  ])('$frameName/$disposition → tab: $tab', ({ frameName, disposition, tab }) => {
    expect(isNewBrowserTabPopupIntent({ frameName, disposition })).toBe(tab)
  })
})
