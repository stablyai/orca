import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

it('commits exact bytes when a chunk and its retry reach one upload together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-upload-order-'))
  const service = new SkillUploadSessionService(root)
  try {
    const bytes = Buffer.from('compressed archive bytes')
    const identity = {
      packageId: 'fixture',
      versionId: '1',
      packageDigest: '1'.repeat(64),
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      compressedBytes: bytes.length
    }
    const { uploadId } = await service.begin({ package: identity })
    const request = { uploadId, offset: 0, bytesBase64: bytes.toString('base64') }

    const [first, retry, committed] = await Promise.all([
      service.append(request),
      service.append(request),
      service.commit(uploadId)
    ])

    expect(first.acknowledgedOffset).toBe(bytes.length)
    expect(retry.acknowledgedOffset).toBe(bytes.length)
    expect(committed.uploadId).toBe(uploadId)
    const taken = await service.take(uploadId, identity)
    try {
      expect(await readFile(taken.archivePath)).toEqual(bytes)
    } finally {
      await taken.cleanup()
    }
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
