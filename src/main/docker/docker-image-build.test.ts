import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEngineFake } from './docker-engine-fake'
import {
  buildDockerImage,
  computeDockerImageCacheKey,
  resolveDockerfile
} from './docker-image-build'

describe('docker-image-build', () => {
  let repoPath: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'orca-docker-image-test-'))
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('prefers .devcontainer/Dockerfile over .orca/Dockerfile', async () => {
    await mkdir(path.join(repoPath, '.devcontainer'))
    await mkdir(path.join(repoPath, '.orca'))
    await writeFile(path.join(repoPath, '.devcontainer', 'Dockerfile'), 'FROM node:24\n')
    await writeFile(path.join(repoPath, '.orca', 'Dockerfile'), 'FROM ubuntu:24.04\n')

    const result = await resolveDockerfile(repoPath)

    expect(result).toMatchObject({
      dockerfilePath: path.join(repoPath, '.devcontainer', 'Dockerfile'),
      content: 'FROM node:24\n',
      isGenerated: false
    })
  })

  it('uses .orca/Dockerfile when no devcontainer Dockerfile exists', async () => {
    await mkdir(path.join(repoPath, '.orca'))
    await writeFile(path.join(repoPath, '.orca', 'Dockerfile'), 'FROM ubuntu:24.04\n')

    const result = await resolveDockerfile(repoPath)

    expect(result.dockerfilePath).toBe(path.join(repoPath, '.orca', 'Dockerfile'))
  })

  it('builds a generated default Dockerfile and returns a handle', async () => {
    const engine = new DockerEngineFake()

    const image = await buildDockerImage({
      repoPath,
      repoIdentity: 'stablyai/orca',
      engine,
      now: () => 123
    })

    expect(image).toMatchObject({
      id: 'sha256:fake-image-1',
      builtAt: 123,
      dockerfilePath: 'auto-generated:orca-default'
    })
    expect(engine.commands[0]).toMatchObject({
      command: 'image.build',
      options: { contextPath: repoPath, dockerfileContent: expect.stringContaining('FROM ubuntu') }
    })
  })

  it('includes repo identity in the cache key', () => {
    const a = computeDockerImageCacheKey({ dockerfileContent: 'FROM node\n', repoIdentity: 'a' })
    const b = computeDockerImageCacheKey({ dockerfileContent: 'FROM node\n', repoIdentity: 'b' })
    expect(a).not.toBe(b)
  })

  it('surfaces image build failures', async () => {
    const engine = new DockerEngineFake()
    engine.nextBuildError = new Error('build failed')

    await expect(buildDockerImage({ repoPath, engine })).rejects.toThrow('build failed')
  })
})
