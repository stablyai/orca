import { describe, expect, it } from 'vitest'
import { createClientAuthorityEpoch } from './client-authority-epoch'

describe('createClientAuthorityEpoch', () => {
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
