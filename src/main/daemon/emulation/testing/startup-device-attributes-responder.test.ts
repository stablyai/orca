import { describe, expect, it } from 'vitest'
import { StartupDeviceAttributesQueryFilter } from '../startup-device-attributes-responder'

describe('startup device attributes query filter', () => {
  it('removes a DA1 query split at every chunk boundary', () => {
    for (const query of ['\x1b[c', '\x1b[0c']) {
      for (let split = 1; split < query.length; split++) {
        const filter = new StartupDeviceAttributesQueryFilter()
        expect(filter.accept(`before${query.slice(0, split)}`)).toBe('before')
        expect(filter.accept(`${query.slice(split)}after`)).toBe('after')
        expect(filter.release()).toBe('')
      }
    }
  })

  it('releases incomplete and non-DA1 sequences unchanged', () => {
    const filter = new StartupDeviceAttributesQueryFilter()

    expect(filter.accept('before\x1b[')).toBe('before')
    expect(filter.release()).toBe('\x1b[')
    expect(filter.accept('\x1b[>c')).toBe('\x1b[>c')
  })
})
