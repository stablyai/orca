import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

const roots: string[] = []

afterEach(async () => {
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

describe('SkillUploadSessionService', () => {
  it('retries initialization after a transient failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const initializeRoot = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient-init-failure'))
      .mockImplementationOnce(async () => {
        await mkdir(uploads, { recursive: true })
      })
    const service = new SkillUploadSessionService(uploads, { initializeRoot })
    const request = { package: identity(Buffer.from('new package')) }

    await expect(service.begin(request)).rejects.toThrow('transient-init-failure')
    await expect(service.begin(request)).resolves.toMatchObject({ acknowledgedOffset: 0 })
    expect(initializeRoot).toHaveBeenCalledTimes(2)
  })

  it('removes abandoned staging bytes when a runtime starts a fresh service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    await mkdir(uploads)
    await writeFile(join(uploads, 'abandoned.tar.gz'), 'partial package')
    const service = new SkillUploadSessionService(uploads)

    await service.begin({ package: identity(Buffer.from('new package')) })

    expect(await readdir(uploads)).not.toContain('abandoned.tar.gz')
  })

  it('accepts monotonic chunks, acknowledges identical retries, and transfers ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const service = new SkillUploadSessionService(join(root, 'uploads'))
    const bytes = Buffer.from('immutable skill package')
    const packageIdentity = identity(bytes)
    const begun = await service.begin({ package: packageIdentity })
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'uploads'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, 'uploads', `${begun.uploadId}.tar.gz`))).mode & 0o777).toBe(
        0o600
      )
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
    const service = new SkillUploadSessionService(join(root, 'uploads'))
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
    expect(await readdir(join(root, 'uploads'))).toEqual([`${begun.uploadId}.tar.gz`])
  })

  it('removes an abandoned upload when its idle lifetime expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = new SkillUploadSessionService(uploads, { idleMs: 20 })
    const begun = await service.begin({ package: identity(Buffer.from('abandoned')) })
    await service.append({ uploadId: begun.uploadId, offset: 0, bytesBase64: 'YQ==' })

    await vi.waitFor(async () => expect(await readdir(uploads)).toEqual([]))
    await expect(
      service.append({ uploadId: begun.uploadId, offset: 1, bytesBase64: 'Yg==' })
    ).rejects.toThrow('skill-upload-session-unavailable')
  })

  it('keeps a taken archive until its new owner cleans it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    vi.useFakeTimers()
    try {
      const service = new SkillUploadSessionService(join(root, 'uploads'), { idleMs: 20 })
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

      await vi.advanceTimersByTimeAsync(40)
      await expect(readFile(staged.archivePath)).resolves.toEqual(bytes)
      await expect(service.take(begun.uploadId, packageIdentity)).rejects.toThrow(
        'skill-upload-session-unavailable'
      )
      await staged.cleanup()
      await staged.cleanup()
      await expect(readFile(staged.archivePath)).rejects.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects gaps, changed retries, and an archive hash mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-session-'))
    roots.push(root)
    const service = new SkillUploadSessionService(join(root, 'uploads'))
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
