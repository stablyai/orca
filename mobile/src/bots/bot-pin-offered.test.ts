import { describe, expect, it } from 'vitest'
import { botPinOffered } from './bot-pin-offered'

describe('botPinOffered', () => {
  it('offers Pin where the host takes it and the list is writable', () => {
    expect(botPinOffered({ takesPin: true }, false)).toBe(true)
    expect(
      botPinOffered({ takesPin: true, host: { id: 'runtime:s1', label: 'Studio' } }, false)
    ).toBe(true)
  })

  it('offers no Pin to an older host, whose strict bots.update refuses the field', () => {
    expect(botPinOffered({}, false)).toBe(false)
    expect(botPinOffered({ host: { id: 'runtime:s1', label: 'Studio' } }, false)).toBe(false)
  })

  it('offers no Pin on a read-only list or from a computer that is down', () => {
    expect(botPinOffered({ takesPin: true }, true)).toBe(false)
    expect(
      botPinOffered(
        { takesPin: true, host: { id: 'runtime:s1', label: 'Studio', word: 'Offline' } },
        false
      )
    ).toBe(false)
  })
})
