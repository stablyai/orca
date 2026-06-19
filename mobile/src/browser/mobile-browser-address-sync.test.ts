import { describe, expect, it } from 'vitest'

import { resolveMobileBrowserAddressSync } from './mobile-browser-address-sync'

describe('resolveMobileBrowserAddressSync', () => {
  it('syncs the tab URL when the input is not focused', () => {
    const result = resolveMobileBrowserAddressSync(
      { focused: false, url: 'https://old.example/' },
      { focused: false, url: 'https://new.example/' }
    )

    expect(result).toEqual({
      nextState: { focused: false, url: 'https://new.example/' },
      shouldSyncValue: true
    })
  })

  it('defers tab URL sync while the user is editing', () => {
    const result = resolveMobileBrowserAddressSync(
      { focused: false, url: 'https://old.example/' },
      { focused: true, url: 'https://new.example/' }
    )

    expect(result).toEqual({
      nextState: { focused: true, url: 'https://new.example/' },
      shouldSyncValue: false
    })
  })

  it('syncs the latest tab URL when editing ends', () => {
    const result = resolveMobileBrowserAddressSync(
      { focused: true, url: 'https://new.example/' },
      { focused: false, url: 'https://new.example/' }
    )

    expect(result).toEqual({
      nextState: { focused: false, url: 'https://new.example/' },
      shouldSyncValue: true
    })
  })

  it('preserves externally updated address text when focus and tab URL are unchanged', () => {
    const previous = { focused: false, url: 'https://new.example/' }
    const result = resolveMobileBrowserAddressSync(previous, {
      focused: false,
      url: 'https://new.example/'
    })

    expect(result).toEqual({
      nextState: previous,
      shouldSyncValue: false
    })
  })
})
