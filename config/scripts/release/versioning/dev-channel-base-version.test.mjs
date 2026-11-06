import { describe, expect, it } from 'vitest'
import { resolveDevChannelBaseVersion } from './dev-channel-base-version.mjs'

describe('dev channel base version', () => {
  // Deleted v1.4.202 release once reset hourlies below installed 1.4.203; channel tags retain the floor.
  it('does not drop below an already-published channel version', () => {
    expect(
      resolveDevChannelBaseVersion('1.4.197', [
        'v1.4.201',
        'v1.4.202-hourly.202609141912',
        'v1.4.203-hourly.202609140417'
      ])
    ).toBe('1.4.203')
  })
})
