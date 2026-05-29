import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEngineFake } from '../docker/docker-engine-fake'
import { DockerContainerRegistry } from './docker-container-registry'

describe('DockerContainerRegistry', () => {
  let repoPath: string
  let engine: DockerEngineFake
  let registry: DockerContainerRegistry

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'orca-docker-registry-test-'))
    engine = new DockerEngineFake()
    registry = new DockerContainerRegistry(engine)
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('creates and caches a running container per worktree', async () => {
    const first = await registry.getOrCreateContainer('repo-1::/repo/wt', repoPath)
    const second = await registry.getOrCreateContainer('repo-1::/repo/wt', repoPath)

    expect(second.id).toBe(first.id)
    expect(engine.commands.filter((command) => command.command === 'image.build')).toHaveLength(1)
    expect(
      engine.commands.filter((command) => command.command === 'container.create')
    ).toHaveLength(1)
    expect(engine.commands[0]).toMatchObject({
      command: 'image.build',
      options: {
        labels: expect.objectContaining({
          'dev.orca.repo': 'repo-1'
        })
      }
    })
  })

  it('deduplicates concurrent creates for the same worktree', async () => {
    engine.buildDelayMs = 20

    const [first, second] = await Promise.all([
      registry.getOrCreateContainer('wt-1', repoPath),
      registry.getOrCreateContainer('wt-1', repoPath)
    ])

    expect(second.id).toBe(first.id)
    expect(
      engine.commands.filter((command) => command.command === 'container.create')
    ).toHaveLength(1)
  })

  it('terminates one cached container', async () => {
    const container = await registry.getOrCreateContainer('wt-1', repoPath)

    await registry.terminateContainer('wt-1')

    expect(engine.commands).toEqual(
      expect.arrayContaining([
        { command: 'container.stop', id: container.id },
        { command: 'container.rm', id: container.id }
      ])
    )
  })

  it('terminates all cached containers', async () => {
    const first = await registry.getOrCreateContainer('wt-1', repoPath)
    const second = await registry.getOrCreateContainer('wt-2', repoPath)

    await registry.terminateAll()

    expect(engine.commands).toEqual(
      expect.arrayContaining([
        { command: 'container.rm', id: first.id },
        { command: 'container.rm', id: second.id }
      ])
    )
  })
})
