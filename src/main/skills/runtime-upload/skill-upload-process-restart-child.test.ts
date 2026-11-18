import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { describe, it } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

const CHILD = process.env.ORCA_SKILL_UPLOAD_PROCESS_CHILD === '1'
const BYTES = Buffer.from('upload process restart package')

function packageIdentity() {
  return {
    packageId: 'package_restart',
    versionId: 'version_restart',
    packageDigest: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(BYTES).digest('hex'),
    compressedBytes: BYTES.length
  }
}

async function stopAtBoundary(uploadId: string): Promise<void> {
  const marker = process.env.ORCA_SKILL_UPLOAD_RESTART_MARKER
  if (!marker) {
    throw new Error('missing-upload-restart-marker')
  }
  const handle = await open(marker, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, uploadId })}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await new Promise<void>(() => undefined)
}

describe.runIf(CHILD)('skill upload process restart child', () => {
  it('stops at the requested upload boundary', async () => {
    const root = process.env.ORCA_SKILL_UPLOAD_RESTART_ROOT
    const boundary = process.env.ORCA_SKILL_UPLOAD_RESTART_BOUNDARY
    if (!root || !boundary) {
      throw new Error('missing-upload-restart-configuration')
    }
    const service = new SkillUploadSessionService(root)
    const begun = await service.begin({
      package: packageIdentity(),
      transferId: 'operation-restart'
    })
    if (boundary === 'begun') {
      await stopAtBoundary(begun.uploadId)
    }
    const split = Math.floor(BYTES.length / 2)
    await service.append({
      uploadId: begun.uploadId,
      offset: 0,
      bytesBase64: BYTES.subarray(0, split).toString('base64')
    })
    if (boundary === 'partial') {
      await stopAtBoundary(begun.uploadId)
    }
    await service.append({
      uploadId: begun.uploadId,
      offset: split,
      bytesBase64: BYTES.subarray(split).toString('base64')
    })
    if (boundary === 'uploaded') {
      await stopAtBoundary(begun.uploadId)
    }
    await service.commit(begun.uploadId)
    if (boundary === 'committed') {
      await stopAtBoundary(begun.uploadId)
    }
    throw new Error('unknown-upload-restart-boundary')
  })
})
