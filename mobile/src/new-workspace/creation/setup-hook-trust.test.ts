import { describe, expect, it } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import {
  approvedCreateSetup,
  createSetupNeedsTrustCheck,
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

  it('pins empty setup when the created branch shows none, so setup it adds is asked about', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { hooks: null, source: null, setupConfig: null },
      _meta: { runtimeId: 'runtime-1' }
    })
    const result = await resolveCreateSetupApproval({
      client,
      trust: {},
      repos: REPOS,
      repo: { id: 'repo-1', displayName: 'marlin' },
      createSource: { kind: 'base', baseBranch: 'origin/main' }
    })
    expect(result).toEqual({
      approved: {
        approvedSetupHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }
    })
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
    const shown = { repoId: 'repo-1', contentHash: 'shown-hash' }
    expect(approvedCreateSetup(REPOS, shown, false)).toEqual({ approvedSetupHash: 'shown-hash' })
    expect(approvedCreateSetup(REPOS, shown, true)).toEqual({})
  })
})

describe('create setup trust check', () => {
  it("checks a work item's own repo regardless of the selected repo's skip policy", () => {
    expect(
      createSetupNeedsTrustCheck({
        sameRepo: false,
        decision: 'inherit',
        runPolicy: 'skip-by-default'
      })
    ).toBe(true)
  })

  it("keeps an explicit skip for a work item's own repo", () => {
    expect(
      createSetupNeedsTrustCheck({ sameRepo: false, decision: 'skip', runPolicy: 'run-by-default' })
    ).toBe(false)
  })
})
