import { describe, expect, it, vi } from 'vitest'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { resolveGhAccountRequiredHost } from './account-binding-required-host'

describe('resolveGhAccountRequiredHost', () => {
  it('filters a dotted alias that resolves to github.com to github.com', async () => {
    const remoteUrl = 'git@work.github.com:example/sample-app.git'
    const resolveAlias = vi.fn(async () => ({ hostname: 'github.com' }))
    await expect(
      resolveGhAccountRequiredHost(
        {
          path: '/repos/sample-app',
          gitRemoteIdentity: { remoteUrl, canonicalKey: normalizeGitRemoteUrl(remoteUrl) ?? '' }
        },
        {},
        resolveAlias
      )
    ).resolves.toBe('github.com')
    expect(resolveAlias).toHaveBeenCalledWith('work.github.com', {
      repoPath: '/repos/sample-app',
      connectionId: null
    })
  })
})
