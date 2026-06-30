import { describe, expect, it, vi } from 'vitest'

// DevcontainerRuntime imports the PTY provider, which imports native node-pty
// (no prebuilt binary here); stub it so the module graph loads under vitest.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { DevcontainerRuntime } from './devcontainer-runtime'
import type { DockerClient, DockerInspect } from './docker-client'

const KEY = '/Users/me/work/aprium'

/** A `docker inspect` fixture for the test container in the given run state. */
function inspect(running: boolean): DockerInspect {
  return {
    Id: 'cid-1',
    Name: '/aprium-dev',
    Config: { Labels: { 'devcontainer.local_folder': KEY } },
    Mounts: [{ Type: 'bind', Source: KEY, Destination: '/workspaces/aprium' }],
    State: { Running: running }
  }
}

/** A stub DockerClient resolving the test container, with optional overrides. */
function client(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    listContainersByLabel: vi.fn(async () => [{ ID: 'cid-1', Names: 'aprium-dev' }]),
    inspectContainer: vi.fn(async () => inspect(true)),
    startContainer: vi.fn(async () => {}),
    ...overrides
  }
}

describe('DevcontainerRuntime.resolveContainerId', () => {
  it('resolves the container id for the host key and caches mounts for translation', async () => {
    const c = client()
    const runtime = new DevcontainerRuntime({ containerKey: KEY, client: c })

    expect(await runtime.resolveContainerId()).toBe('cid-1')
    // includes stopped containers so a stopped devcontainer can be started
    expect(c.listContainersByLabel).toHaveBeenCalledWith('devcontainer.local_folder', { all: true })
    // mounts now populated → cwd translation works
    expect(runtime.hostToContainerCwd(`${KEY}/.worktrees/feat`)).toBe(
      '/workspaces/aprium/.worktrees/feat'
    )
  })

  it('starts the container when it is stopped', async () => {
    const startContainer = vi.fn(async () => {})
    const runtime = new DevcontainerRuntime({
      containerKey: KEY,
      client: client({ inspectContainer: vi.fn(async () => inspect(false)), startContainer })
    })
    await runtime.resolveContainerId()
    expect(startContainer).toHaveBeenCalledWith('cid-1')
  })

  it('does not start an already-running container', async () => {
    const startContainer = vi.fn(async () => {})
    const runtime = new DevcontainerRuntime({
      containerKey: KEY,
      client: client({ startContainer })
    })
    await runtime.resolveContainerId()
    expect(startContainer).not.toHaveBeenCalled()
  })

  it('throws when no devcontainer matches the key', async () => {
    const runtime = new DevcontainerRuntime({
      containerKey: '/Users/me/work/missing',
      client: client()
    })
    await expect(runtime.resolveContainerId()).rejects.toThrow(/No devcontainer found/)
  })

  it('createPtyProvider wires resolution + translation end to end', async () => {
    const fake = {
      pid: 1,
      process: 'docker',
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn()
    }
    const ptySpawn = vi.fn(() => fake as never)
    const runtime = new DevcontainerRuntime({
      containerKey: KEY,
      client: client(),
      resolveSpawnEnv: () => ({ ANTHROPIC_API_KEY: 'secret' }),
      ptySpawn
    })
    const provider = runtime.createPtyProvider()
    await provider.spawn({ cols: 80, rows: 24, cwd: `${KEY}/.worktrees/feat` })

    const [, args] = ptySpawn.mock.calls[0] as unknown as [string, string[]]
    expect(args).toContain('cid-1')
    expect(args).toContain('/workspaces/aprium/.worktrees/feat')
    expect(args).toContain('ANTHROPIC_API_KEY')
  })
})
