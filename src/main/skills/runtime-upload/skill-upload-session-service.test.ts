import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

const roots: string[] = []
const services: SkillUploadSessionService[] = []

function createUploadService(
  ...args: ConstructorParameters<typeof SkillUploadSessionService>
): SkillUploadSessionService {
  const service = new SkillUploadSessionService(...args)
  services.push(service)
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function identity(bytes: Buffer) {
  return {
    packageId: 'package_1',
    versionId: 'version_1',
    packageDigest: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    compressedBytes: bytes.length
  }
}

async function stagedArchives(uploads: string): Promise<string[]> {
  const owners = await readdir(uploads, { withFileTypes: true })
  const archives = await Promise.all(
    owners
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await readdir(join(uploads, entry.name)))
          .filter((name) => name.endsWith('.tar.gz'))
          .map((name) => join(uploads, entry.name, name))
      )
  )
  return archives.flat().sort()
}

describe('SkillUploadSessionService', () => {
  it('rejects a staging root that redirects through a symlink or junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const outside = join(root, 'outside')
    const uploads = join(root, 'uploads')
    await mkdir(outside)
    await symlink(outside, uploads, process.platform === 'win32' ? 'junction' : 'dir')
    const service = createUploadService(uploads)

    await expect(service.begin({ package: identity(Buffer.from('new package')) })).rejects.toThrow(
      'skill-upload-staging-root-invalid'
    )
    expect(await readdir(outside)).toEqual([])
  })

  it('never lets a second service delete a live upload owned by the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const first = createUploadService(uploads)
    const second = createUploadService(uploads)
    const firstBytes = Buffer.from('first live package')
    const firstUpload = await first.begin({ package: identity(firstBytes) })
    await first.append({
      uploadId: firstUpload.uploadId,
      offset: 0,
      bytesBase64: firstBytes.subarray(0, 5).toString('base64')
    })

    const secondUpload = await second.begin({ package: identity(Buffer.from('second package')) })
    const archives = await stagedArchives(uploads)
    const firstPath = archives.find((path) => path.endsWith(`${firstUpload.uploadId}.tar.gz`))

    expect(await readdir(uploads)).toHaveLength(2)
    expect(archives).toHaveLength(2)
    expect(firstPath).toBeDefined()
    await expect(readFile(firstPath!)).resolves.toEqual(firstBytes.subarray(0, 5))
    await second.cancel(secondUpload.uploadId)
    expect(await stagedArchives(uploads)).toEqual([firstPath])
    await first.cancel(firstUpload.uploadId)
    expect(await stagedArchives(uploads)).toEqual([])
    await Promise.all([first.dispose(), second.dispose()])
    expect(await readdir(uploads)).toEqual([])
  })

  it('serializes concurrent admission at four sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = createUploadService(uploads)
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        service.begin({
          package: identity(Buffer.from(`package-${index}`)),
          transferId: `operation-${index}`
        })
      )
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await stagedArchives(uploads)).toHaveLength(4)
    await service.dispose()
    expect(await readdir(uploads)).toEqual([])
  })

  it('accepts monotonic chunks, acknowledges identical retries, and transfers ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const service = createUploadService(join(root, 'uploads'))
    const bytes = Buffer.from('immutable skill package')
    const packageIdentity = identity(bytes)
    const begun = await service.begin({ package: packageIdentity })
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'uploads'))).mode & 0o777).toBe(0o700)
      const [archivePath] = await stagedArchives(join(root, 'uploads'))
      expect((await stat(archivePath!)).mode & 0o777).toBe(0o600)
    }
    const first = bytes.subarray(0, 8)
    const second = bytes.subarray(8)

    await expect(
      service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: first.toString('base64') })
    ).resolves.toEqual({ acknowledgedOffset: first.length })
    await expect(
      service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: first.toString('base64') })
    ).resolves.toEqual({ acknowledgedOffset: first.length })
    await service.append({
      uploadId: begun.uploadId,
      offset: first.length,
      bytesBase64: second.toString('base64')
    })
    await expect(service.commit(begun.uploadId)).resolves.toEqual({ uploadId: begun.uploadId })
    await expect(service.commit(begun.uploadId)).resolves.toEqual({ uploadId: begun.uploadId })
    const staged = await service.take(begun.uploadId, packageIdentity)
    await expect(readFile(staged.archivePath)).resolves.toEqual(bytes)
    await staged.cleanup()
    await expect(readFile(staged.archivePath)).rejects.toThrow()
  })

  it('resumes an idempotent transfer without allocating another session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const service = createUploadService(join(root, 'uploads'))
    const bytes = Buffer.from('resumable package')
    const packageIdentity = identity(bytes)
    const request = { package: packageIdentity, transferId: 'operation-1' }
    const begun = await service.begin(request)
    await service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: 'cmVzdW1l' })

    await expect(service.begin(request)).resolves.toEqual({
      uploadId: begun.uploadId,
      chunkBytes: begun.chunkBytes,
      acknowledgedOffset: 6
    })
    await expect(
      service.begin({
        package: { ...packageIdentity, packageId: 'different-package' },
        transferId: request.transferId
      })
    ).rejects.toThrow('skill-upload-transfer-mismatch')
    expect((await stagedArchives(join(root, 'uploads'))).map((path) => basename(path))).toEqual([
      `${begun.uploadId}.tar.gz`
    ])
  })

  it('keeps a taken archive until retryable cleanup succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    vi.useFakeTimers()
    try {
      const service = createUploadService(join(root, 'uploads'))
      const bytes = Buffer.from('owned package')
      const packageIdentity = identity(bytes)
      const begun = await service.begin({ package: packageIdentity })
      await service.append({
        uploadId: begun.uploadId,
        offset: 0,
        bytesBase64: bytes.toString('base64')
      })
      await service.commit(begun.uploadId)
      const staged = await service.take(begun.uploadId, packageIdentity)

      await vi.advanceTimersByTimeAsync(20 * 60_000)
      await expect(readFile(staged.archivePath)).resolves.toEqual(bytes)
      await expect(service.take(begun.uploadId, packageIdentity)).rejects.toThrow(
        'skill-upload-session-unavailable'
      )
      await service.dispose()
      await expect(service.begin({ package: packageIdentity })).rejects.toThrow(
        'skill-upload-service-disposed'
      )
      await expect(readFile(staged.archivePath)).resolves.toEqual(bytes)
      const retainedPath = `${staged.archivePath}.retained`
      await rename(staged.archivePath, retainedPath)
      await mkdir(staged.archivePath)
      await expect(staged.cleanup()).rejects.toThrow()
      await rm(staged.archivePath, { recursive: true })
      await rename(retainedPath, staged.archivePath)
      await staged.cleanup()
      await staged.cleanup()
      await expect(readFile(staged.archivePath)).rejects.toThrow()
      expect(await readdir(join(root, 'uploads'))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains failed archive cleanup within the four-path admission bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = createUploadService(uploads)
    const begun = await service.begin({ package: identity(Buffer.from('retained')) })
    const [archivePath] = await stagedArchives(uploads)
    const retainedPath = `${archivePath}.retained`
    await rename(archivePath!, retainedPath)
    await mkdir(archivePath!)

    await expect(service.cancel(begun.uploadId)).rejects.toThrow()
    const replacements = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        service.begin({ package: identity(Buffer.from(`replacement-${index}`)) })
      )
    )
    expect(replacements).toHaveLength(3)
    await expect(service.begin({ package: identity(Buffer.from('over-budget')) })).rejects.toThrow(
      'skill-upload-session-limit'
    )

    await rm(archivePath!, { recursive: true })
    await rename(retainedPath, archivePath!)
    await service.dispose()
    expect(await readdir(uploads)).toEqual([])
  })

  it('rejects gaps, changed retries, and an archive hash mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const service = createUploadService(join(root, 'uploads'))
    const bytes = Buffer.from('package')
    const packageIdentity = identity(bytes)
    const begun = await service.begin({ package: packageIdentity })
    await expect(
      service.append({ uploadId: begun.uploadId, offset: 1, bytesBase64: 'YQ==' })
    ).rejects.toThrow('skill-upload-offset-invalid')
    await service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: 'YQ==' })
    await expect(
      service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: 'Yg==' })
    ).rejects.toThrow('skill-upload-retry-mismatch')
    await service.append({
      uploadId: begun.uploadId,
      offset: 1,
      bytesBase64: Buffer.from('xxxxxx').toString('base64')
    })
    await expect(service.commit(begun.uploadId)).rejects.toThrow(
      'skill-upload-archive-hash-mismatch'
    )
  })
})
