import { describe, expect, it } from 'vitest'
import { listedOwnerRows, listRoutedTargetsApart } from './daemon-pty-target-inspection'

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

  it('keeps routed targets’ rows when resolving an unrouted one fails', async () => {
    await expect(
      listRoutedTargetsApart(
        ['pty-routed', 'pty-exited'],
        (id) => id === 'pty-routed',
        async (ids) => ids.map((id) => ({ id })),
        async () => {
          throw new Error('owner_unavailable')
        }
      )
    ).resolves.toEqual([{ id: 'pty-routed' }])
  })
})
