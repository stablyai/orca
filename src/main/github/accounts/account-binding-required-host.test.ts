import { describe, expect, it, vi } from 'vitest'
import { resolveGhAccountRequiredHost } from './account-binding-required-host'

function repoFor(remoteUrl: string, canonicalHost?: string) {
  const host =
    canonicalHost ??
    remoteUrl
      .replace(/^git@/, '')
      .replace(/^ssh:\/\/(?:[^@]+@)?/, '')
      .split(/[:/]/)[0]
      ?.toLowerCase() ??
    'github.com'
  return {
    path: '/repos/sample-app',
    connectionId: null,
    gitRemoteIdentity: {
      canonicalKey: `${host}/example/sample-app`,
      remoteUrl
    }
  }
}

describe('resolveGhAccountRequiredHost', () => {
  it('keeps a dotted enterprise host literal unless ssh config points it at github.com', async () => {
    for (const resolveAlias of [
      async () => ({ hostname: '10.0.0.5' }),
      async () => ({ hostname: null }),
      async () => {
        throw new Error('ssh -G failed')
      }
    ]) {
      await expect(
        resolveGhAccountRequiredHost(
          repoFor('git@ghe.example.com:example/sample-app.git'),
          {},
          resolveAlias
        )
      ).resolves.toBe('ghe.example.com')
    }
  })

  it('filters a dotted alias that resolves to github.com to github.com', async () => {
    const resolveAlias = vi.fn(async () => ({ hostname: 'github.com' }))
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@work.github.com:example/sample-app.git'),
        {},
        resolveAlias
      )
    ).resolves.toBe('github.com')
    expect(resolveAlias).toHaveBeenCalledWith('work.github.com', {
      repoPath: '/repos/sample-app',
      connectionId: null
    })
  })

  it('expands an SCP alias whose path has a leading slash', async () => {
    await expect(
      resolveGhAccountRequiredHost(
        repoFor('git@github-work:/example/sample-app.git', 'github-work'),
        {},
        async () => ({ hostname: 'github.com' })
      )
    ).resolves.toBe('github.com')
  })
})
