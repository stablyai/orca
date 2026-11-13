import { describe, expect, it } from 'vitest'
import { createClientAuthorityEpoch } from './client-authority-epoch'

describe('createClientAuthorityEpoch', () => {
  it('keeps a token stale after the host changes away and back with the same client', () => {
    const epoch = createClientAuthorityEpoch()
    const client = { getGeneration: () => 1 }
    const hostA = { client, hostId: 'host-a', executionHost: undefined, worktreeId: 'wt-1' }
    epoch.update(hostA)
    const token = epoch.token()
    expect(epoch.isCurrent(token)).toBe(true)

    epoch.update({ ...hostA, hostId: 'host-b' })
    epoch.update(hostA)

    expect(epoch.isCurrent(token)).toBe(false)
  })

  it('expires a token when the client generation moves without a new update', () => {
    const epoch = createClientAuthorityEpoch()
    let generation = 1
    epoch.update({
      client: { getGeneration: () => generation },
      hostId: 'host-a',
      executionHost: undefined,
      worktreeId: 'wt-1'
    })
    const token = epoch.token()

    generation = 2

    expect(epoch.isCurrent(token)).toBe(false)
  })
})
