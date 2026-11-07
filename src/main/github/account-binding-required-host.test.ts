import { describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { resolveGhAccountRequiredHost } from './account-binding-required-host'

function repoFor(remoteUrl: string) {
  return {
    path: '/repos/sample-app',
    gitRemoteIdentity: {
      remoteName: 'origin',
      remoteUrl,
      canonicalKey: normalizeGitRemoteUrl(remoteUrl) ?? ''
    }
  }
}

describe('resolveGhAccountRequiredHost', () => {
  // #37288: the common multi-account Host alias has a dot, so it used to be kept as the gh host.
  it('filters a dotted SSH alias by the host it resolves to', async () => {
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github.com-work:example/sample-app.git'),
        {},
        async () => ({ hostname: 'github.com' })
      )
    ).resolves.toBe('github.com')
  })

  it('keeps a dotted SSH host literal when ssh config cannot expand it', async () => {
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@ghe.example.com:example/sample-app.git'),
        {},
        async () => ({ hostname: null })
      )
    ).resolves.toBe('ghe.example.com')
  })

  it('keeps a dotted Enterprise host whose ssh config points at another endpoint', async () => {
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@ghe.example.com:example/sample-app.git'),
        {},
        async () => ({ hostname: '10.0.0.5' })
      )
    ).resolves.toBe('ghe.example.com')
  })
})
