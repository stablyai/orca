import { describe, expect, it, vi } from 'vitest'
import {
  deriveRepoSlug,
  findRepoMatchingSlug,
  findRepoMatchingSlugForPaste,
  lookupGitHubItemByOwnerRepo,
  resolvePasteIntent,
  type PasteRepoCandidate
} from './smart-source-paste-intent'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'

describe('resolvePasteIntent', () => {
  it('classifies a GitHub issue/PR URL as a github-link', () => {
    expect(resolvePasteIntent('https://github.com/acme/widgets/pull/12')).toEqual({
      kind: 'github-link',
      link: { slug: { owner: 'acme', repo: 'widgets', host: 'github.com' }, number: 12, type: 'pr' }
    })
  })

  it('classifies a bare #number as a github-number', () => {
    expect(resolvePasteIntent('#42')).toEqual({ kind: 'github-number', number: 42 })
  })

  it('classifies a GitLab MR URL as a gitlab-link', () => {
    const intent = resolvePasteIntent('https://gitlab.com/group/proj/-/merge_requests/8')
    expect(intent?.kind).toBe('gitlab-link')
    if (intent?.kind === 'gitlab-link') {
      expect(intent.link).toMatchObject({ number: 8, type: 'mr' })
    }
  })

  it('returns null for plain search text', () => {
    expect(resolvePasteIntent('login bug')).toBeNull()
  })

  it('rejects oversized paste intents before any exact lookup', () => {
    expect(
      resolvePasteIntent(`https://github.com/acme/widgets/issues/12/${'x'.repeat(2048)}`)
    ).toBeNull()
  })
})

describe('deriveRepoSlug', () => {
  it('prefers the upstream identity', () => {
    expect(deriveRepoSlug({ upstream: { owner: 'up', repo: 'stream' } })).toEqual({
      owner: 'up',
      repo: 'stream'
    })
  })

  it('preserves an Enterprise upstream host', () => {
    expect(
      deriveRepoSlug({
        upstream: { owner: 'up', repo: 'stream', host: 'github.corp.example' }
      })
    ).toEqual({ owner: 'up', repo: 'stream', host: 'github.corp.example' })
  })

  it('parses an SSH remote URL', () => {
    expect(
      deriveRepoSlug({ gitRemoteIdentity: { remoteUrl: 'git@github.com:acme/widgets.git' } })
    ).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('parses an HTTPS remote URL', () => {
    expect(
      deriveRepoSlug({ gitRemoteIdentity: { remoteUrl: 'https://github.com/acme/widgets' } })
    ).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('returns null when no slug can be derived', () => {
    expect(deriveRepoSlug({})).toBeNull()
  })
})

describe('findRepoMatchingSlug', () => {
  const repos: PasteRepoCandidate[] = [
    { id: 'a', displayName: 'A', slug: { owner: 'acme', repo: 'widgets' } },
    { id: 'b', displayName: 'B', slug: null }
  ]

  it('matches case-insensitively', () => {
    expect(findRepoMatchingSlug(repos, { owner: 'Acme', repo: 'Widgets' })?.id).toBe('a')
  })

  it('returns null when no repo matches', () => {
    expect(findRepoMatchingSlug(repos, { owner: 'other', repo: 'thing' })).toBeNull()
  })

  it('does not match a GHES link to a same-named github.com repo', () => {
    expect(
      findRepoMatchingSlug(repos, {
        owner: 'acme',
        repo: 'widgets',
        host: 'github.corp.example'
      })
    ).toBeNull()
  })

  it('falls back to the host-aware repo slug RPC for SSH and enterprise repos', async () => {
    const calls: string[] = []
    const operations = {
      resolveGitHubRepoSlug: async (repoId: string) => {
        calls.push(repoId)
        return {
          supported: true,
          slug:
            repoId === 'b'
              ? { owner: 'enterprise', repo: 'widgets', host: 'github.corp.example' }
              : null
        }
      }
    } as unknown as HostWorkspaceCreationOperations
    await expect(
      findRepoMatchingSlugForPaste(
        operations,
        repos,
        { owner: 'enterprise', repo: 'widgets', host: 'github.corp.example' },
        new Map()
      )
    ).resolves.toMatchObject({ id: 'b' })
    expect(calls).toEqual(['a', 'b'])
  })

  it('keeps local matching usable when an older desktop lacks the repo slug RPC', async () => {
    let calls = 0
    const operations = {
      resolveGitHubRepoSlug: async () => {
        calls += 1
        return { supported: false, slug: null }
      }
    } as unknown as HostWorkspaceCreationOperations
    const cache = new Map<string, { owner: string; repo: string } | null>()

    await expect(
      findRepoMatchingSlugForPaste(
        operations,
        repos,
        { owner: 'enterprise', repo: 'widgets' },
        cache
      )
    ).resolves.toBeNull()
    await expect(
      findRepoMatchingSlugForPaste(operations, repos, { owner: 'enterprise', repo: 'other' }, cache)
    ).resolves.toBeNull()
    expect(calls).toBe(1)
  })

  it('keeps local matching usable when the optional repo slug lookup rejects', async () => {
    const operations = {
      resolveGitHubRepoSlug: async () => {
        throw new Error('connection closed')
      }
    } as unknown as HostWorkspaceCreationOperations

    await expect(
      findRepoMatchingSlugForPaste(
        operations,
        repos,
        { owner: 'enterprise', repo: 'widgets' },
        new Map()
      )
    ).resolves.toBeNull()
  })

  it('sends the pasted host through the exact owner/repo lookup RPC', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const operations = {
      lookupGitHubItemByOwnerRepo: lookup
    } as unknown as HostWorkspaceCreationOperations

    await lookupGitHubItemByOwnerRepo(
      operations,
      'repo-1',
      { owner: 'acme', repo: 'widgets', host: 'github.corp.example' },
      7,
      'pr'
    )

    expect(lookup).toHaveBeenCalledWith({
      repoId: 'repo-1',
      slug: { owner: 'acme', repo: 'widgets', host: 'github.corp.example' },
      number: 7,
      type: 'pr'
    })
  })
})
