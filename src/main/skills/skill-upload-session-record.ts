import type { FileHandle } from 'node:fs/promises'
import type { SkillUploadBeginRequest } from '../../shared/skill-upload-session-contract'

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
