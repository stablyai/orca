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

  it('returns stat, search, and file list results from JSON stdout', async () => {
    engine.enqueueExecResult({ stdout: JSON.stringify({ size: 1, type: 'file', mtime: 2 }) })
    engine.enqueueExecResult({
      stdout: JSON.stringify({ files: [], totalMatches: 0, truncated: false })
    })
    engine.enqueueExecResult({ stdout: JSON.stringify(['src/index.ts']) })

    await expect(provider.stat('/workspace/a.txt')).resolves.toMatchObject({ type: 'file' })
    await expect(provider.search({ rootPath: '/workspace', query: 'TODO' })).resolves.toMatchObject(
      {
        totalMatches: 0
      }
    )
    await expect(provider.listFiles('/workspace')).resolves.toEqual(['src/index.ts'])
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
