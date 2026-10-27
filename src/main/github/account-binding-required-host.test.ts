import { describe, expect, it, vi } from 'vitest'
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
  it('keeps a github.com remote filtered to github.com', async () => {
    const resolveAlias = vi.fn()
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github.com:example/sample-app.git'),
        {},
        resolveAlias
      )
    ).resolves.toBe('github.com')
    expect(resolveAlias).not.toHaveBeenCalled()
  })

  it('keeps a real enterprise host without resolving an alias', async () => {
    const resolveAlias = vi.fn()
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@ghe.example.com:example/sample-app.git'),
        {},
        resolveAlias
      )
    ).resolves.toBe('ghe.example.com')
    expect(resolveAlias).not.toHaveBeenCalled()
  })

  it('filters an alias that resolves to github.com the same as a direct github.com remote', async () => {
    const resolveAlias = vi.fn(async () => ({ hostname: 'github.com' }))
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github-personal:example/sample-app.git'),
        {},
        resolveAlias
      )
    ).resolves.toBe('github.com')
    expect(resolveAlias).toHaveBeenCalledWith('github-personal', {
      repoPath: '/repos/sample-app',
      connectionId: null
    })
  })

  it('folds ssh.github.com and www.github.com to github.com', async () => {
    for (const hostname of ['ssh.github.com', 'www.github.com']) {
      await expect(
        resolveGhAccountRequiredHost(
          repoFor('git@github-work:example/sample-app.git'),
          {},
          async () => ({ hostname })
        )
      ).resolves.toBe('github.com')
    }
  })

  it('keeps the exact resolved enterprise hostname, including a www prefix', async () => {
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github-work:example/sample-app.git'),
        {},
        async () => ({ hostname: 'GHE.Example.com' })
      )
    ).resolves.toBe('ghe.example.com')
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github-work:example/sample-app.git'),
        {},
        async () => ({ hostname: 'www.ghe.example.com' })
      )
    ).resolves.toBe('www.ghe.example.com')
  })

  it('resolves the alias in the WSL distro that runs gh', async () => {
    const resolveAlias = vi.fn(async () => ({ hostname: 'github.com' }))
    await resolveGhAccountRequiredHost(
      repoFor('git@github-personal:example/sample-app.git'),
      { wslDistro: 'Ubuntu' },
      resolveAlias
    )
    expect(resolveAlias).toHaveBeenCalledWith('github-personal', {
      repoPath: '/repos/sample-app',
      connectionId: null,
      wslDistro: 'Ubuntu'
    })
  })

  it('resolves the alias with its original case', async () => {
    const resolveAlias = vi.fn(async () => ({ hostname: 'github.com' }))
    await resolveGhAccountRequiredHost(
      repoFor('git@GitHub-Work:example/sample-app.git'),
      {},
      resolveAlias
    )
    expect(resolveAlias).toHaveBeenCalledWith('GitHub-Work', expect.anything())
  })

  it('keeps a dotless HTTPS host literal without consulting ssh config', async () => {
    const resolveAlias = vi.fn(async () => ({ hostname: 'elsewhere.example.com' }))
    await expect(
      resolveGhAccountRequiredHost(repoFor('https://ghe/example/sample-app.git'), {}, resolveAlias)
    ).resolves.toBe('ghe')
    expect(resolveAlias).not.toHaveBeenCalled()
  })

  it('does not filter when the alias cannot be resolved', async () => {
    for (const resolveAlias of [
      async () => ({ hostname: null }),
      async () => ({ hostname: 'github-personal' }),
      async () => {
        throw new Error('ssh -G failed')
      }
    ]) {
      await expect(
        resolveGhAccountRequiredHost(
          repoFor('git@github-personal:example/sample-app.git'),
          {},
          resolveAlias
        )
      ).resolves.toBeUndefined()
    }
  })
})
