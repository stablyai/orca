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

  it('surfaces unmerged status records as unresolved conflicts', async () => {
    engine.enqueueExecResult({
      stdout: 'u UU N... 100644 100644 100644 100644 abc def ghi src/conflicted file.ts\n'
    })
    engine.enqueueExecResult({ stdout: '.git\n' })

    const result = await provider.getStatus('/workspace')

    expect(result.entries).toEqual([
      {
        path: 'src/conflicted file.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      }
    ])
  })

  it('returns original and modified contents for staged diffs', async () => {
    engine.enqueueExecResult({ stdout: 'head content\n' })
    engine.enqueueExecResult({ stdout: 'staged content\n' })

    const result = await provider.getDiff('/workspace', 'src/app.ts', true)

    expect(result).toEqual({
      kind: 'text',
      originalContent: 'head content\n',
      modifiedContent: 'staged content\n',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    expect(engine.commands.map((command) => command.command)).toEqual([
      'container.exec',
      'container.exec'
    ])
    expect(engine.commands[0]).toMatchObject({
      options: { args: ['git', 'show', 'HEAD:src/app.ts'] }
    })
    expect(engine.commands[1]).toMatchObject({
      options: { args: ['git', 'show', ':src/app.ts'] }
    })
  })

  it('returns original and modified contents for unstaged diffs', async () => {
    engine.enqueueExecResult({ stdout: 'index content\n' })
    engine.enqueueExecResult({ stdout: 'working content\n' })

    const result = await provider.getDiff('/workspace', 'src/app.ts', false)

    expect(result).toMatchObject({
      originalContent: 'index content\n',
      modifiedContent: 'working content\n'
    })
    expect(engine.commands[0]).toMatchObject({
      options: { args: ['git', 'show', ':src/app.ts'] }
    })
    expect(engine.commands[1]).toMatchObject({
      options: { args: ['cat', '--', 'src/app.ts'] }
    })
  })

  it('returns empty original content and working-tree content for untracked diffs', async () => {
    engine.enqueueExecResult({ stdout: '' })
    engine.enqueueExecResult({ stdout: 'new file\n' })

    const result = await provider.getDiff('/workspace', 'src/new.ts', false)

    expect(result).toMatchObject({
      originalContent: '',
      modifiedContent: 'new file\n'
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

  it('preserves the new path when parsing renamed branch entries', async () => {
    engine.enqueueExecResult({ stdout: 'base-sha\n' })
    engine.enqueueExecResult({ stdout: 'R100\tsrc/old.ts\tsrc/new.ts\n' })
    engine.enqueueExecResult({ stdout: 'head-sha\n' })

    const result = await provider.getBranchCompare('/workspace', 'origin/main')

    expect(result.entries).toEqual([
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }
    ])
  })

  it('returns blob contents for branch diffs and uses oldPath for renamed originals', async () => {
    engine.enqueueExecResult({ stdout: 'old content\n' })
    engine.enqueueExecResult({ stdout: 'new content\n' })

    const result = await provider.getBranchDiff('/workspace', 'base-sha', {
      includePatch: true,
      filePath: 'src/new.ts',
      oldPath: 'src/old.ts'
    })

    expect(result).toEqual([
      {
        kind: 'text',
        originalContent: 'old content\n',
        modifiedContent: 'new content\n',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    ])
    expect(engine.commands[0]).toMatchObject({
      options: { args: ['git', 'show', 'base-sha:src/old.ts'] }
    })
    expect(engine.commands[1]).toMatchObject({
      options: { args: ['git', 'show', 'HEAD:src/new.ts'] }
    })
  })

  it('uses the resolved default branch for remote file URLs', async () => {
    engine.enqueueExecResult({ stdout: 'git@github.com:stablyai/orca.git\n' })
    engine.enqueueExecResult({ stdout: 'refs/remotes/origin/master\n' })

    const result = await provider.getRemoteFileUrl('/workspace', 'src/app.ts', 42)

    expect(result).toBe('https://github.com/stablyai/orca/blob/master/src/app.ts#L42')
    expect(engine.commands[1]).toMatchObject({
      options: { args: ['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'] }
    })
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
