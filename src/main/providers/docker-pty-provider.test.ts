import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DockerEngineFake } from '../docker/docker-engine-fake'
import type { DockerTarget } from '../docker/types'
import { DockerPtyProvider } from './docker-pty-provider'

describe('DockerPtyProvider', () => {
  let engine: DockerEngineFake
  let provider: DockerPtyProvider
  let target: DockerTarget

  beforeEach(() => {
    engine = new DockerEngineFake()
    target = {
      containerId: 'container-1',
      workdir: '/workspace',
      image: {
        id: 'sha256:image',
        cacheKey: 'cache-key',
        dockerfilePath: 'Dockerfile',
        builtAt: 1
      }
    }
    provider = new DockerPtyProvider(target, engine)
  })

  it('returns the container id as connection id', () => {
    expect(provider.getConnectionId()).toBe('container-1')
  })

  it('spawns a shell inside the Docker container', async () => {
    const result = await provider.spawn({ cols: 80, rows: 24 })

    expect(result).toEqual({ id: 'session-1' })
    expect(engine.commands[0]).toMatchObject({
      command: 'container.exec.spawn',
      options: {
        containerId: 'container-1',
        args: ['/bin/sh'],
        cwd: '/workspace',
        tty: true,
        cols: 80,
        rows: 24
      }
    })
  })

  it('forwards writes, resizes, data, and exit events', async () => {
    const data = vi.fn()
    const exit = vi.fn()
    provider.onData(data)
    provider.onExit(exit)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const session = engine.sessions.get(id)!

    provider.write(id, 'hello')
    provider.resize(id, 120, 40)
    session.emitData('output')
    session.crash(137)

    expect(session.writes).toEqual(['hello'])
    expect(session.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(data).toHaveBeenCalledWith({ id, data: 'output' })
    expect(exit).toHaveBeenCalledWith({ id, code: 137 })
    await expect(provider.hasChildProcesses(id)).resolves.toBe(false)
  })

  it('reattaches to an existing session', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    engine.sessions.get(id)!.emitData('buffered')

    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: id })).resolves.toEqual({
      id,
      isReattach: true,
      replay: 'buffered'
    })
  })

  it('marks requested missing sessions as expired and starts fresh', async () => {
    await expect(
      provider.spawn({ cols: 80, rows: 24, sessionId: 'missing' })
    ).resolves.toMatchObject({
      id: 'session-1',
      sessionExpired: true
    })
  })
})
