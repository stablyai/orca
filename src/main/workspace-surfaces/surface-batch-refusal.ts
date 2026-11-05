import type { SurfaceCommandOutcome } from '../../shared/workspace-surfaces/surface-command'
import type { SurfaceStorageResult } from '../../shared/workspace-surfaces/surface-storage-command'

/** A multi-holder action cannot commit one holder after another refused it. */
export class SurfaceBatchRefusal extends Error {
  constructor(readonly outcome: SurfaceCommandOutcome) {
    super(outcome.status === 'conflict' ? outcome.code : 'terminal_tab_pinned')
  }
}

export function assertSurfaceBatchAccepted(
  results: readonly { outcome: SurfaceStorageResult['outcome'] }[]
): void {
  if (results.length < 2) {
    return
  }
  for (const { outcome } of results) {
    if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) {
      continue
    }
    if (outcome.status === 'conflict' && 'current' in outcome) {
      throw new SurfaceBatchRefusal(outcome)
    }
    if (outcome.status === 'accepted' && 'result' in outcome && outcome.result.refused?.length) {
      throw new SurfaceBatchRefusal({
        ...outcome,
        surfaces: [],
        result: { refused: outcome.result.refused },
        effects: { startPaneKeys: [], stopPtyIds: [] }
      })
    }
  }
}
