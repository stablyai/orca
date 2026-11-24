import { describe, expect, it } from 'vitest'
import { getTimezoneFlags } from './automation-timezone-flag'

describe('automations --timezone', () => {
  it('names a known zone and refuses an unknown one', () => {
    expect(getTimezoneFlags(new Map([['timezone', 'Asia/Tokyo']]))).toEqual({
      timezone: 'Asia/Tokyo',
      timezoneExplicit: true
    })
    expect(getTimezoneFlags(new Map())).toEqual({})
    expect(() => getTimezoneFlags(new Map([['timezone', 'Mars/Olympus']]))).toThrow(
      /Unknown time zone "Mars\/Olympus"/
    )
  })
})
