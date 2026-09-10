import type { MaestroRunProgressV2 } from '../../../src/shared/maestro-run-progress'
import type { MobileMaestroProgressEntry } from './mobile-maestro-progress-model'

export function buildMobileRunCompletion(
  completion: MaestroRunProgressV2['completion']
): MobileMaestroProgressEntry[] {
  if (!completion) {
    return []
  }
  return [
    {
      key: 'run-completion',
      title: 'Coordinator summary',
      label: `Completed by ${completion.completed_by.handle} · coordinator generation ${completion.completed_by.generation} · ${completion.evidence.length} evidence item${completion.evidence.length === 1 ? '' : 's'}`,
      detail: completion.summary,
      state: completion.waivers.length ? `${completion.waivers.length} waived` : undefined
    },
    ...completion.evidence.map((evidence, index) => ({
      key: `run-evidence-${index}`,
      title: `Evidence ${index + 1}`,
      detail: evidence
    })),
    ...completion.waivers.map((waiver) => ({
      key: `run-waiver-${waiver.task_id}`,
      title: `Waived ${waiver.task_id}`,
      detail: waiver.reason
    }))
  ]
}
