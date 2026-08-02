import { describe, expect, it, vi } from 'vitest'
import { resolveRelayPushTarget } from './git-handler-push-target'

type GitArgs = string[]

function gitForConfig(config: {
  branch?: string
  pushRemote?: string | Error
  pushDefault?: string | Error
  branchRemote?: string | Error
  merge?: string
  base?: string | Error
  remotes?: string[]
  remoteUrls?: Record<string, string>
}) {
  const branch = config.branch ?? 'feature/fix'
  const merge = config.merge ?? `refs/heads/${branch}`
  return vi.fn(async (args: GitArgs) => {
    if (args[0] === 'symbolic-ref') {
      return { stdout: `${branch}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[2] === `branch.${branch}.pushRemote`) {
      if (config.pushRemote instanceof Error) {
        throw config.pushRemote
      }
      return { stdout: `${config.pushRemote ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[2] === 'remote.pushDefault') {
      if (config.pushDefault instanceof Error) {
        throw config.pushDefault
      }
      return { stdout: `${config.pushDefault ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[2] === `branch.${branch}.remote`) {
      if (config.branchRemote instanceof Error) {
        throw config.branchRemote
      }
      return { stdout: `${config.branchRemote ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[2] === `branch.${branch}.merge`) {
      return { stdout: `${merge}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[2] === `branch.${branch}.base`) {
      if (config.base instanceof Error) {
        throw config.base
      }
      return { stdout: `${config.base ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${config.remotes?.join('\n') ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const remoteUrl = config.remoteUrls?.[args[2] ?? '']
      if (!remoteUrl) {
        throw new Error('missing remote URL')
      }
      return { stdout: `${remoteUrl}\n`, stderr: '' }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

describe('resolveRelayPushTarget', () => {
  it('uses branch pushRemote for a configured review head branch', async () => {
    const git = gitForConfig({
      pushRemote: 'fork',
      branchRemote: 'fork',
      merge: 'refs/heads/contributor/fix'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:contributor/fix'
    })
  })

  it('does not combine remote.pushDefault with a base-branch merge target', async () => {
    const git = gitForConfig({
      branch: 'feature/fix',
      pushRemote: new Error('missing pushRemote'),
      pushDefault: 'fork',
      branchRemote: 'origin',
      merge: 'refs/heads/main',
      base: 'refs/remotes/origin/main'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toBeNull()
  })

  it('keeps a fork head target when the contributor branch matches the base branch name', async () => {
    const git = gitForConfig({
      branch: 'review/pr-1',
      pushRemote: 'fork',
      branchRemote: 'fork',
      merge: 'refs/heads/main',
      base: 'refs/remotes/origin/main'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:main'
    })
  })

  it('uses remote.pushDefault when branch pushRemote is missing', async () => {
    const git = gitForConfig({
      pushRemote: new Error('missing pushRemote'),
      pushDefault: 'fork',
      branchRemote: 'origin'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature/fix'
    })
  })

  it('normalizes a URL-valued branch remote to a matching named remote', async () => {
    const forkUrl = 'https://github.com/contributor/orca.git'
    const git = gitForConfig({
      pushRemote: new Error('missing pushRemote'),
      pushDefault: new Error('missing pushDefault'),
      branchRemote: forkUrl,
      remotes: ['origin', 'pr-contributor-orca'],
      remoteUrls: {
        origin: 'https://github.com/stablyai/orca.git',
        'pr-contributor-orca': forkUrl
      }
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'pr-contributor-orca',
      refspec: 'HEAD:feature/fix'
    })
  })

  it('keeps a URL-valued pushRemote when no named remote matches it', async () => {
    const forkUrl = 'git@github.com:contributor/orca.git'
    const git = gitForConfig({
      pushRemote: forkUrl,
      branchRemote: forkUrl,
      remotes: ['origin'],
      remoteUrls: {
        origin: 'git@github.com:stablyai/orca.git'
      }
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: forkUrl,
      refspec: 'HEAD:feature/fix'
    })
  })

  it('uses an explicit push target without reading branch config', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }))

    await expect(
      resolveRelayPushTarget(git, '/repo', {
        remoteName: 'fork',
        branchName: 'feature/head'
      })
    ).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature/head'
    })
    expect(git).toHaveBeenCalledWith(['check-ref-format', '--branch', 'feature/head'], '/repo')
  })
})
