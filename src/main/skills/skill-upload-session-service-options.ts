import type { hashSkillUploadArchive } from './skill-upload-archive-hash'
import type { SkillUploadStagingOwnershipOptions } from './skill-upload-staging-ownership'

export type SkillUploadSessionServiceOptions = {
  idleMs?: number
  initializeRoot?: () => Promise<void>
  hashArchive?: typeof hashSkillUploadArchive
  ownership?: SkillUploadStagingOwnershipOptions
}
