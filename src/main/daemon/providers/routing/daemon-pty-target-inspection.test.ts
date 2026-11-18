import { describe, expect, it } from 'vitest'
import { listedOwnerRows } from './daemon-pty-target-inspection'

describe('a target listing across owners', () => {
  it('keeps the rows of owners that answered when another owner fails', () => {
    expect(
      listedOwnerRows([
        { status: 'rejected', reason: new Error('owner_unavailable') },
        { status: 'fulfilled', value: [{ id: 'pty-b' }] }
      ])
    ).toEqual([{ id: 'pty-b' }])
  })

  it('fails when no owner answered', () => {
    expect(() =>
      listedOwnerRows([{ status: 'rejected', reason: new Error('owner_unavailable') }])
    ).toThrow('owner_unavailable')
  })
})
