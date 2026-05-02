import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DockerEngineFake } from '../docker/docker-engine-fake'
import type { DockerTarget } from '../docker/types'
import { DockerFilesystemProvider } from './docker-filesystem-provider'

describe('DockerFilesystemProvider', () => {
  let engine: DockerEngineFake
  let provider: DockerFilesystemProvider

  beforeEach(() => {
    engine = new DockerEngineFake()
    const target: DockerTarget = {
      containerId: 'container-1',
      workdir: '/workspace',
      image: { id: 'sha256:image', cacheKey: 'key', dockerfilePath: 'Dockerfile', builtAt: 1 }
    }
    provider = new DockerFilesystemProvider(target, engine)
  })

  it('reads directories through docker exec', async () => {
    engine.enqueueExecResult({
      stdout: JSON.stringify([{ name: 'src', isDirectory: true, isSymlink: false }])
    })

    await expect(provider.readDir('/workspace')).resolves.toEqual([
      { name: 'src', isDirectory: true, isSymlink: false }
    ])
    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: {
        containerId: 'container-1',
        args: ['node', '-e', expect.any(String), '/workspace']
      }
    })
  })

  it('writes files using stdin instead of shell interpolation', async () => {
    await provider.writeFile('/workspace/a.txt', 'hello')

    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: { input: 'hello' }
    })
  })

  it('writes binary content through stdin instead of argv', async () => {
    await provider.writeFileBase64('/workspace/a.bin', Buffer.from([0, 1, 2]).toString('base64'))

    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: { input: 'AAEC' }
    })
  })

  it('translates trusted host paths into container paths', async () => {
    provider = new DockerFilesystemProvider(
      {
        containerId: 'container-1',
        workdir: '/workspace',
        hostWorktreePath: '/Users/me/repo',
        hostPlatform: 'darwin',
        image: { id: 'sha256:image', cacheKey: 'key', dockerfilePath: 'Dockerfile', builtAt: 1 }
      },
      engine
    )
    engine.enqueueExecResult({ stdout: JSON.stringify({ size: 1, type: 'file', mtime: 2 }) })

    await provider.stat('/Users/me/repo/src/app.ts')

    expect(engine.commands[0]).toMatchObject({
      options: { args: ['node', '-e', expect.any(String), '/workspace/src/app.ts'] }
    })
  })

  it('rejects paths outside the container workdir before docker exec', async () => {
    await expect(provider.readFile('/etc/passwd')).rejects.toThrow('resolves outside')
    await expect(provider.writeFile('../outside.txt', 'x')).rejects.toThrow('resolves outside')
    expect(engine.commands).toHaveLength(0)
  })

  it('returns stat, search, and file list results from docker exec', async () => {
    engine.enqueueExecResult({ stdout: JSON.stringify({ size: 1, type: 'file', mtime: 2 }) })
    engine.enqueueExecResult({
      stdout:
        '{"type":"match","data":{"path":{"text":"/workspace/src/app.ts"},"line_number":3,"lines":{"text":"TODO item\\n"},"submatches":[{"start":0,"end":4}]}}\n'
    })
    engine.enqueueExecResult({ stdout: JSON.stringify(['src/index.ts']) })

    await expect(provider.stat('/workspace/a.txt')).resolves.toMatchObject({ type: 'file' })
    await expect(provider.search({ rootPath: '/workspace', query: 'TODO' })).resolves.toMatchObject(
      {
        totalMatches: 1,
        files: [
          expect.objectContaining({
            relativePath: 'src/app.ts'
          })
        ]
      }
    )
    await expect(provider.listFiles('/workspace')).resolves.toEqual(['src/index.ts'])
    expect(engine.commands[1]).toMatchObject({
      options: {
        args: expect.arrayContaining(['rg', '--json', '--hidden'])
      }
    })
  })

  it('passes regex, whole-word, include, and exclude options to rg', async () => {
    engine.enqueueExecResult({ stdout: '' })

    await provider.search({
      rootPath: '/workspace',
      query: 'TODO|FIXME',
      useRegex: true,
      wholeWord: true,
      includePattern: '*.ts',
      excludePattern: '*.test.ts'
    })

    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: {
        args: expect.arrayContaining([
          'rg',
          '--word-regexp',
          '--glob',
          '*.ts',
          '--glob',
          '!*.test.ts'
        ])
      }
    })
    const command = engine.commands[0]
    expect(command.command).toBe('container.exec')
    if (command.command === 'container.exec') {
      expect(command.options.args).not.toContain('--fixed-strings')
    }
  })

  it('registers and unregisters watches without a real daemon watcher', async () => {
    const callback = vi.fn()
    const unwatch = await provider.watch('/workspace', callback)

    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec',
      options: { args: ['sh', '-lc', 'true'], cwd: '/workspace' }
    })
    unwatch()
  })

  it('surfaces docker exec failures', async () => {
    engine.nextExecError = new Error('container crashed')

    await expect(provider.readFile('/workspace/a.txt')).rejects.toThrow('container crashed')
  })
})
