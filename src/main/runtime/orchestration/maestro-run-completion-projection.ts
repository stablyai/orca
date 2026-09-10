import type { MaestroRunProgressV2 } from '../../../shared/maestro-run-progress'
import type { RunCompletion } from './types'

export function projectMaestroRunCompletion(
  completion: RunCompletion | undefined
): Pick<MaestroRunProgressV2, 'completion'> {
  if (!completion) {
    return {}
  }
  return {
    completion: {
      state: 'completed',
      summary: completion.summary,
      evidence: completion.evidence,
      waivers: completion.waivers,
      completed_at: completion.completed_at,
      completed_by: {
        handle: completion.completed_by_handle,
        generation: completion.completed_by_generation
      }
    }
  }
}
