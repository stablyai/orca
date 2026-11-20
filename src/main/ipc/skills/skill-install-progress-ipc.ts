import {
  publishToDocuments,
  appDocumentFor,
  type AppCaller
} from '../app-registry/app-handler-registry'

import type { SkillBundleInstallProgress } from '../../../shared/skills/installation/skill-bundle-install-contract'
import type { SkillInstallProgress } from '../../../shared/skills/sharing/skill-sharing-contract'

export function sendSkillInstallProgress(event: AppCaller, progress: SkillInstallProgress): void {
  if (!appDocumentFor(event).isDestroyed()) {
    publishToDocuments('skills:installProgress', progress, appDocumentFor(event).caller)
  }
}

export function sendBundleInstallProgress(
  event: AppCaller,
  progress: SkillBundleInstallProgress
): void {
  sendSkillInstallProgress(event, {
    operationId: progress.operationId,
    phase: 'installing',
    currentSkill: {
      id: progress.skillId,
      name: progress.skillName,
      index: progress.skillIndex,
      total: progress.skillCount
    }
  })
}
