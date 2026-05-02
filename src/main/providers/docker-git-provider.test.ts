import { beforeEach, describe, expect, it } from 'vitest'
import { DockerEngineFake } from '../docker/docker-engine-fake'
import type { DockerTarget } from '../docker/types'
import { DockerGitProvider } from './docker-git-provider'

describe('DockerGitProvider', () => {
  let engine: DockerEngineFake
  let provider: DockerGitProvider

  beforeEach(() => {
    engine = new DockerEngineFake()
    const target: DockerTarget = {
      containerId: 'container-1',
      workdir: '/workspace',
      image: { id: 'sha256:image', cacheKey: 'key', dockerfilePath: 'Dockerfile', builtAt: 1 }
    }
    provider = new DockerGitProvider(target, engine)
  })

  it('routes status through git inside the container', async () => {
    engine.enqueueExecResult({
      stdout: '1 M. N... 100644 100644 100644 abc abc src/app.ts\n? new.txt\n'
    })
    engine.enqueueExecResult({ stdout: '.git\n' })

    const result = await provider.getStatus('/workspace')

    expect(result.entries).toEqual([
      { path: 'src/app.ts', status: 'modified', area: 'staged' },
      { path: 'new.txt', status: 'untracked', area: 'untracked' }
    ])
    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: {
        args: ['git', 'status', '--porcelain=v2', '--untracked-files=all'],
        cwd: '/workspace'
      }
    })
  })

  it('stages, unstages, and discards files with git commands', async () => {
    await provider.stageFile('/workspace', 'a.ts')
    await provider.unstageFile('/workspace', 'a.ts')
    await provider.discardChanges('/workspace', 'a.ts')

    expect(engine.commands.map((command) => command.command)).toEqual([
      'container.exec',
      'container.exec',
      'container.exec'
    ])
    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: { args: ['git', 'add', '--', 'a.ts'] }
    })
  })

  it('detects merge conflicts', async () => {
    engine.enqueueExecResult({ stdout: '.git\n' })

    await expect(provider.detectConflictOperation('/workspace')).resolves.toBe('merge')
  })

  it('checks git repo status asynchronously', async () => {
    engine.enqueueExecResult({ stdout: '/workspace\n' })

    await expect(provider.isGitRepoAsync('/workspace')).resolves.toEqual({
      isRepo: true,
      rootPath: '/workspace'
    })
  })

  it('surfaces container crashes during git operations', async () => {
    engine.nextExecError = new Error('container crashed')

    await expect(provider.stageFile('/workspace', 'a.ts')).rejects.toThrow('container crashed')
  })
})
