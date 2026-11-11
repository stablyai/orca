import { describe, expect, it, vi } from 'vitest'

vi.mock('../../github-repository-identity', () => ({ withGitHubRepoExecution: vi.fn() }))

const { matchOwnerRepoLookup } = await import('./get-work-item')

const requested = { owner: 'octo', repo: 'widgets', host: 'github.com' }

describe('matchOwnerRepoLookup', () => {
  it("reads the workspace's own repo for full lookups and previews", () => {
    const candidates = [{ owner: 'octo', repo: 'widgets', host: 'github.com' }]
    expect(matchOwnerRepoLookup(requested, candidates, {})).toEqual(candidates[0])
    expect(matchOwnerRepoLookup(requested, candidates, { preview: true })).toEqual(candidates[0])
  })

  it('previews another repo on a host the workspace already uses', () => {
    const candidates = [{ owner: 'acme', repo: 'api', host: 'github.com' }]
    expect(matchOwnerRepoLookup(requested, candidates, { preview: true })).toEqual(requested)
    expect(matchOwnerRepoLookup(requested, candidates, {})).toBeUndefined()
  })

  it('lets a workspace with no GitHub remotes preview github.com only', () => {
    expect(matchOwnerRepoLookup(requested, [], { preview: true })).toEqual(requested)
    expect(matchOwnerRepoLookup(requested, [], {})).toBeUndefined()
    const enterprise = { owner: 'octo', repo: 'widgets', host: 'git.example.com' }
    expect(matchOwnerRepoLookup(enterprise, [], { preview: true })).toBeUndefined()
  })

  it('never sends a preview to a host other than the configured one', () => {
    const candidates = [{ owner: 'acme', repo: 'api', host: 'git.example.com' }]
    expect(matchOwnerRepoLookup(requested, candidates, { preview: true })).toBeUndefined()
  })
})
