import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasMutationResult,
  RuntimeMaestroWorkspaceCanvasQueryResult
} from '../../../../shared/runtime-types'

export type MaestroWorkspaceProjectionWait = {
  projectionAttempts?: number
  projectionIntervalMs?: number
}

const DEFAULT_ATTEMPTS = 20
const DEFAULT_INTERVAL_MS = 100

function waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export async function reconcileCreatedMaestroWorkspaceSurface(params: {
  surfaceId: NonNullable<RuntimeMaestroWorkspaceCanvasMutationResult['surface_id']>
  query: () => Promise<RuntimeMaestroWorkspaceCanvasQueryResult>
  wait?: MaestroWorkspaceProjectionWait
}): Promise<RuntimeMaestroWorkspaceCanvasQueryResult> {
  const attempts = params.wait?.projectionAttempts ?? DEFAULT_ATTEMPTS
  const intervalMs = params.wait?.projectionIntervalMs ?? DEFAULT_INTERVAL_MS
  const signal = AbortSignal.timeout(Math.max(250, attempts * intervalMs + 250))
  let result = await params.query()
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (
      result.status === 'available' &&
      result.snapshot.surfaces[workspaceSurfaceKey(params.surfaceId)]
    ) {
      return result
    }
    await waitForInterval(intervalMs, signal)
    if (signal.aborted) {
      break
    }
    result = await params.query()
  }
  return result
}

export function createdSurfaceMutationResult(params: {
  isCreate: boolean
  beforeAuthorityRevision: number
  canvasRevision: number
  surfaceId: RuntimeMaestroWorkspaceCanvasMutationResult['surface_id']
  after: RuntimeMaestroWorkspaceCanvasQueryResult
}): RuntimeMaestroWorkspaceCanvasMutationResult {
  const { after, surfaceId } = params
  const projected =
    !params.isCreate ||
    (surfaceId !== undefined &&
      after.status === 'available' &&
      after.snapshot.surfaces[workspaceSurfaceKey(surfaceId)] !== undefined)
  return {
    status: after.status === 'available' && projected ? 'applied' : 'outcome_unknown',
    authority_revision:
      after.status === 'available'
        ? after.snapshot.authority_revision
        : params.beforeAuthorityRevision,
    canvas_revision: after.status === 'available' ? after.canvas.revision : params.canvasRevision,
    surface_id: surfaceId,
    ...(!projected ? { reason: 'created_surface_not_projected' } : {}),
    ...(after.status === 'unavailable' || !projected ? { liveness: 'unverifiable' as const } : {})
  }
}
