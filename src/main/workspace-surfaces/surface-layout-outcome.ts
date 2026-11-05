import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'
import { surfaceCommandRefusalSchema } from '../../shared/workspace-surfaces/surface-command'
import type { SurfaceStorageResult } from '../../shared/workspace-surfaces/surface-storage-command'

export function surfaceLayoutOutcome(outcome: SurfaceStorageResult['outcome']): LayoutApplyOutcome {
  if (outcome && typeof outcome === 'object' && 'status' in outcome) {
    if (outcome.status === 'accepted' && 'result' in outcome) {
      return { ok: true, result: outcome.result }
    }
    if (outcome.status === 'conflict') {
      if (outcome.code === 'surface_changed') {
        return { ok: false, code: 'tab_not_found' }
      }
      if (outcome.code === 'pane_changed') {
        return { ok: false, code: 'pane_not_found' }
      }
      const code = surfaceCommandRefusalSchema.safeParse(outcome.code)
      if (
        code.success &&
        code.data !== 'host_not_owned' &&
        code.data !== 'other_partition' &&
        code.data !== 'wsl_move_in_progress'
      ) {
        return { ok: false, code: code.data }
      }
    }
  }
  return { ok: false, code: 'invalid_params' }
}
