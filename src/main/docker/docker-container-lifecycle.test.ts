import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEngineFake } from './docker-engine-fake'
import {
  attachDockerContainer,
  hibernateDockerContainer,
  spawnDockerContainer,
  terminateDockerContainer
} from './docker-container-lifecycle'

describe('docker-container-lifecycle', () => {
  let repoPath: string
  let worktreePath: string
  let engine: DockerEngineFake

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'orca-docker-repo-'))
    worktreePath = await mkdtemp(path.join(tmpdir(), 'orca-docker-worktree-'))
    engine = new DockerEngineFake()
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
    await rm(worktreePath, { recursive: true, force: true })
  })

  it('builds an image, creates a bind-mounted container, and starts it', async () => {
    const result = await spawnDockerContainer({
      repoPath,
      worktreePath,
      repoIdentity: 'repo-1',
      engine,
      platform: 'linux',
      now: () => 456
    })

    expect(result.container).toMatchObject({
      id: 'container-1',
      imageId: 'sha256:fake-image-1',
      startedAt: 456,
      state: 'running'
    })
    expect(engine.commands.map((command) => command.command)).toEqual([
      'image.build',
      'container.create',
      'container.start'
    ])
    expect(engine.commands[1]).toMatchObject({
      command: 'container.create',
      options: { mounts: [{ source: worktreePath, target: '/workspace' }] }
    })
  })

  it('limits image builds to one concurrent build per repo identity', async () => {
    engine.buildDelayMs = 20

    await Promise.all([
      spawnDockerContainer({ repoPath, worktreePath, repoIdentity: 'same', engine }),
      spawnDockerContainer({ repoPath, worktreePath, repoIdentity: 'same', engine })
    ])

    expect(engine.commands.filter((command) => command.command === 'image.build')).toHaveLength(1)
  })

  it('attaches only running containers', async () => {
    const spawned = await spawnDockerContainer({ repoPath, worktreePath, engine })

    await expect(
      attachDockerContainer(engine, spawned.container.id, () => 789)
    ).resolves.toMatchObject({
      id: spawned.container.id,
      state: 'running',
      startedAt: 789
    })

    await hibernateDockerContainer(engine, spawned.container)
    await expect(attachDockerContainer(engine, spawned.container.id)).rejects.toThrow(
      'is not running'
    )
  })

  it('hibernates and terminates containers', async () => {
    const spawned = await spawnDockerContainer({ repoPath, worktreePath, engine })

    await expect(hibernateDockerContainer(engine, spawned.container)).resolves.toMatchObject({
      state: 'hibernated'
    })
    await expect(terminateDockerContainer(engine, spawned.container)).resolves.toMatchObject({
      state: 'terminated'
    })
    expect(engine.commands.map((command) => command.command)).toContain('container.rm')
  })

  it('surfaces build failures before creating a container', async () => {
    engine.nextBuildError = new Error('image build fail')

    await expect(spawnDockerContainer({ repoPath, worktreePath, engine })).rejects.toThrow(
      'image build fail'
    )
    expect(engine.commands.map((command) => command.command)).toEqual(['image.build'])
  })
})
