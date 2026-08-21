import type { FileHandle } from 'node:fs/promises'
import {
  SKILL_UPLOAD_CHUNK_MAX_BYTES,
  type SkillUploadBeginRequest,
  type SkillUploadBeginResult
} from '../../shared/skill-upload-session-contract'

export type SkillUploadSessionRecord = {
  id: string
  path: string
  package: SkillUploadBeginRequest['package']
  transferId: string | null
  handle: FileHandle | null
  idleTimer: ReturnType<typeof setTimeout> | null
  bytesReceived: number
  touchedAt: number
  committed: boolean
}

export function skillUploadBeginResult(session: SkillUploadSessionRecord): SkillUploadBeginResult {
  return {
    uploadId: session.id,
    chunkBytes: SKILL_UPLOAD_CHUNK_MAX_BYTES,
    acknowledgedOffset: session.bytesReceived
  }
}
