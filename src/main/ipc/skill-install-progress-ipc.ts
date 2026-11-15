import type { IpcMainInvokeEvent } from 'electron'
import type { SkillBundleInstallProgress } from '../../shared/skills/installation/skill-bundle-install-contract'
import type { SkillInstallProgress } from '../../shared/skills/sharing/skill-sharing-contract'

export function sendSkillInstallProgress(
  event: IpcMainInvokeEvent,
  progress: SkillInstallProgress
): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send('skills:installProgress', progress)
  }
}

export function sendBundleInstallProgress(
  event: IpcMainInvokeEvent,
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
