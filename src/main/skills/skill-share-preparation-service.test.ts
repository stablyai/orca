import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudVersion } from '../../shared/skill-cloud-contract'
import { SkillSharePreparationService } from './skill-share-preparation-service'

const temporaryDirectories: string[] = []

async function createSource(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-share-preparation-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: retry-skill\ndescription: Retry publication\n---\n\n# Retry\n'
  )
  return { root, source }
}

function publishedVersion(packageId: string, versionId: string): SkillCloudVersion {
  return {
    packageId,
    versionId,
    name: 'retry-skill',
    description: 'Retry publication',
    packageDigest: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 100,
    createdAt: '2026-08-11T12:00:00.000Z',
    releaseNotes: 'retry',
    manifest: {
      schemaVersion: 1,
      packageId,
      versionId,
      name: 'retry-skill',
      description: 'Retry publication',
      createdAt: '2026-08-11T12:00:00.000Z',
      packageDigest: 'a'.repeat(64),
      files: []
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('SkillSharePreparationService', () => {
  it('removes abandoned preparations from a previous process before preparing', async () => {
    const { root, source } = await createSource()
    const preparationRoot = join(root, 'preparations')
    await mkdir(join(preparationRoot, 'abandoned'), { recursive: true })
    await writeFile(join(preparationRoot, 'abandoned', 'package.tar.gz'), 'private bytes')
    const service = new SkillSharePreparationService(preparationRoot, {
      publishVersion: vi.fn(),
      createShare: vi.fn()
    })

    const result = await service.prepare({ sourceDirectory: source })

    expect(await readdir(preparationRoot)).toEqual([result.preparationId])
  })

  it('enforces the preparation cap while archives are still being created', async () => {
    const { root, source } = await createSource()
    const service = new SkillSharePreparationService(join(root, 'preparations'), {
      publishVersion: vi.fn(),
      createShare: vi.fn()
    })

    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => service.prepare({ sourceDirectory: source }))
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: new Error('skill-share-preparation-limit')
    })
  })

  it('reuses a finalized version when share response delivery is lost', async () => {
    const { root, source } = await createSource()
    const publishVersion = vi.fn(async (request: { packageId: string }) => ({
      status: 'ok' as const,
      value: publishedVersion(request.packageId, 'version_retry')
    }))
    const createShare = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        status: 'ok',
        value: { id: 'share_retry', url: 'https://share.test/skills/share/share_retry' }
      })
    const service = new SkillSharePreparationService(join(root, 'preparations'), {
      publishVersion,
      createShare
    })
    const preview = await service.prepare({ sourceDirectory: source })
    const input = {
      preparationId: preview.preparationId,
      releaseNotes: 'retry'
    }
    const progress = vi.fn()

    await expect(service.publish(input, progress)).rejects.toThrow('response lost')
    await expect(service.publish(input, progress)).resolves.toMatchObject({
      status: 'ok',
      value: { version: { versionId: 'version_retry' }, share: { id: 'share_retry' } }
    })

    expect(publishVersion).toHaveBeenCalledOnce()
    expect(createShare).toHaveBeenCalledTimes(2)
    const idempotencyKey = createShare.mock.calls[0]?.[1].idempotencyKey
    expect(idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(idempotencyKey).toBe(createShare.mock.calls[1]?.[1].idempotencyKey)
    expect(createShare.mock.calls[1]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ preparationId: preview.preparationId, phase: 'publishing' })
    )
  })

  it('keeps the finalized version while sign-in is reconnected', async () => {
    const { root, source } = await createSource()
    const publishVersion = vi.fn(async (request: { packageId: string }) => ({
      status: 'ok' as const,
      value: publishedVersion(request.packageId, 'version_reconnect')
    }))
    const createShare = vi
      .fn()
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce({
        status: 'ok',
        value: { id: 'share_retry', url: 'https://share.test/skills/share/share_retry' }
      })
    const service = new SkillSharePreparationService(join(root, 'preparations'), {
      publishVersion,
      createShare
    })
    const preview = await service.prepare({ sourceDirectory: source })

    await expect(
      service.publish({ preparationId: preview.preparationId, releaseNotes: 'retry' })
    ).resolves.toEqual({ status: 'reconnect-required' })
    await expect(
      service.publish({ preparationId: preview.preparationId, releaseNotes: 'retry' })
    ).resolves.toMatchObject({ status: 'ok', value: { share: { id: 'share_retry' } } })

    expect(publishVersion).toHaveBeenCalledOnce()
    expect(createShare.mock.calls[0]?.[1].idempotencyKey).toBe(
      createShare.mock.calls[1]?.[1].idempotencyKey
    )
  })
})
