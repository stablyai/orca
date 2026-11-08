import { describe, expect, it } from 'vitest'
import {
  deriveRepoSlug,
  findRepoMatchingSlugForPaste,
  resolvePasteIntent,
  type PasteRepoCandidate
} from './smart-source-paste-intent'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

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

  it('caches a rejected optional repo slug probe as no match', async () => {
    const client = {
      sendRequest: async () => {
        throw new Error('connection closed')
      }
    } as unknown as RpcClient

    await expect(
      findRepoMatchingSlugForPaste(
        client,
        repos,
        { owner: 'enterprise', repo: 'widgets' },
        new Map()
      )
    ).resolves.toBeNull()
  })
})
