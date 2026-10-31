import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { SKILL_PACKAGE_MAX_COMPRESSED_BYTES } from '../../shared/skill-package-manifest'

export async function hashSkillUploadArchive(path: string): Promise<string> {
  const size = (await stat(path)).size
  if (size < 1 || size > SKILL_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw new Error('skill-upload-size-limit')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
