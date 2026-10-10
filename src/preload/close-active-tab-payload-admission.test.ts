import { describe, expect, it } from 'vitest'
import { admitCloseActiveTabPayload } from './close-active-tab-payload-admission'

describe('admitCloseActiveTabPayload', () => {
  it('preserves the legacy omitted payload', () => {
    expect(admitCloseActiveTabPayload(undefined)).toEqual({ kind: 'legacy' })
  })

  it('admits a nonempty source id', () => {
    expect(admitCloseActiveTabPayload({ sourceId: 'page-1' })).toEqual({
      kind: 'source',
      payload: { sourceId: 'page-1' }
    })
  })

  it.each([null, {}, [], { sourceId: '' }, { sourceId: 1 }, 'page-1'])(
    'rejects malformed payload %#',
    (payload) => {
      expect(admitCloseActiveTabPayload(payload)).toEqual({ kind: 'invalid' })
    }
  )
})
