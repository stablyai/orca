import { describe, expect, it, vi } from 'vitest'
import { syncOrcaRelease } from './sync-orca-release.mjs'

describe('Orca sync API safeguards', () => {
  it('rejects duplicate open PRs before release lookup or Git changes', async () => {
    const github = {
      paginate: vi.fn().mockResolvedValue([{ state: 'open' }, { state: 'open' }]),
      rest: { pulls: { list: vi.fn(), create: vi.fn(), update: vi.fn() }, repos: {} }
    }
    const git = vi.fn()
    await expect(
      syncOrcaRelease({
        github,
        git,
        repo: { owner: 'phocassoftware', repo: 'phorca' },
        base: 'main'
      })
    ).rejects.toThrow('More than one Orca sync PR is open')
    expect(github.paginate).toHaveBeenCalledOnce()
    expect(git).not.toHaveBeenCalled()
    expect(github.rest.pulls.create).not.toHaveBeenCalled()
    expect(github.rest.pulls.update).not.toHaveBeenCalled()
  })

  it('validates malformed override tags before any API or Git calls', async () => {
    const github = { paginate: vi.fn(), rest: { repos: { getReleaseByTag: vi.fn() } } }
    const git = vi.fn()
    await expect(syncOrcaRelease({ github, git, overrideTag: 'main; injected' })).rejects.toThrow(
      'Override must be a stable desktop tag: vX.Y.Z.'
    )
    expect(github.paginate).not.toHaveBeenCalled()
    expect(github.rest.repos.getReleaseByTag).not.toHaveBeenCalled()
    expect(git).not.toHaveBeenCalled()
  })

  it.each([404, 401, 503, undefined])(
    'reports override lookup errors with tag context (%s)',
    async (status) => {
      const lookupError = Object.assign(new Error('Lookup unavailable'), { status })
      const github = {
        paginate: vi.fn().mockResolvedValue([]),
        rest: {
          pulls: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
          repos: { getReleaseByTag: vi.fn().mockRejectedValue(lookupError) }
        }
      }
      const git = vi.fn()
      const result = syncOrcaRelease({
        github,
        git,
        repo: { owner: 'phocassoftware', repo: 'phorca' },
        overrideTag: 'v1.4.224'
      })
      await expect(result).rejects.toThrow(
        status === 404
          ? 'No published stable desktop release exists for v1.4.224.'
          : 'Looking up Orca v1.4.224 failed: Lookup unavailable'
      )
      await expect(result).rejects.toHaveProperty('cause', lookupError)
      expect(git).not.toHaveBeenCalled()
      expect(github.rest.pulls.create).not.toHaveBeenCalled()
      expect(github.rest.pulls.update).not.toHaveBeenCalled()
    }
  )
})
