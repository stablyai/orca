import { describe, expect, it } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import {
  approvedCreateSetup,
  persistSetupHookTrustApproval,
  resolveCreateSetupApproval
} from './setup-hook-trust'

const REPOS = [{ id: 'repo-1' }]

describe('mobile setup approval', () => {
  it('counts an approval of an earlier setup version as repo trust', async () => {
    const client = new FakeSession('connected')
    const result = await resolveCreateSetupApproval({
      client,
      trust: { 'repo-1': { archive: { contentHash: 'old-hash', approvedAt: 1 } } },
      repos: REPOS,
      repo: { id: 'repo-1', displayName: 'marlin' },
      createSource: { kind: 'base' }
    })
    expect(result).toEqual({ approved: {} })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('runs once with the shown hash and stores nothing', async () => {
    const client = new FakeSession('connected')
    const trust = {}
    const next = await persistSetupHookTrustApproval({
      client,
      trust,
      repos: REPOS,
      repoId: 'repo-1',
      contentHash: 'shown-hash',
      alwaysTrust: false
    })
    expect(next).toBe(trust)
    expect(client.sendRequest).not.toHaveBeenCalled()
    const shown = { repoId: 'repo-1', contentHash: 'shown-hash', pinnable: true } as const
    expect(approvedCreateSetup(REPOS, shown, false)).toEqual({ approvedSetupHash: 'shown-hash' })
    expect(approvedCreateSetup(REPOS, shown, true)).toEqual({})
    // A host that read the checkout instead of the created branch gets no hash, so it can't skip setup.
    expect(approvedCreateSetup(REPOS, { ...shown, pinnable: undefined }, false)).toEqual({})
  })
})
