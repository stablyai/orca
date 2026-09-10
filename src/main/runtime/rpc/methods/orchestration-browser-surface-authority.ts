import { canConsumeMaestroIntent } from '../../../../shared/maestro-actor'
import type {
  MaestroBrowserProfileConsentReceipt,
  MaestroBrowserSurfaceActionRequest,
  MaestroBrowserSurfaceRequest
} from '../../../../shared/maestro-browser-surface'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RpcContext } from '../core'
import type { resolveMaestroPrincipal } from '../maestro-principal'
import { requireExactSurface } from './orchestration-browser-surface-observation'

export {
  capturedSurfaceState,
  fileErrorCode,
  NO_PANE_PAINT_REASON,
  observedVisibility,
  persistMaestroBrowserEvidence,
  requireExactSurface,
  showExactSurface,
  UNOBSERVED_PANE_PAINT_REASON,
  withPanePaintObservation
} from './orchestration-browser-surface-observation'

/** Authority, exact-surface resolution and evidence persistence for Browser surfaces. */
type BrowserSurfacePrincipal = Awaited<ReturnType<typeof resolveMaestroPrincipal>>

type ProfileConsentScope = {
  run_id: string
  task_id: string
  attempt_id: string
}

export function requireActiveBrowserProfileConsent(
  profileId: string | null,
  consent: MaestroBrowserProfileConsentReceipt | null | undefined,
  scope: ProfileConsentScope,
  database?: OrchestrationDb,
  workspace?: MaestroBrowserSurfaceRequest['workspace']
): void {
  if (profileId === null && !consent) {
    return
  }
  if (
    profileId === null ||
    !consent ||
    consent.profile_id !== profileId ||
    consent.run_id !== scope.run_id ||
    consent.task_id !== scope.task_id ||
    consent.attempt_id !== scope.attempt_id
  ) {
    throw new OrchestrationError(
      'browser_profile_consent_required',
      'Browser profile selection requires an exact human consent receipt.'
    )
  }
  const issued =
    database && workspace ? database.getMaestroBrowserProfileConsent(consent, workspace) : undefined
  if (!issued) {
    throw new OrchestrationError(
      'browser_profile_consent_not_issued',
      'Browser profile selection requires a receipt issued by this host.'
    )
  }
  const expiresAt = Date.parse(issued.expires_at)
  if (issued.revoked_at !== null || expiresAt <= Date.now()) {
    throw new OrchestrationError(
      'browser_profile_consent_inactive',
      'The Browser profile consent receipt is revoked or expired.'
    )
  }
}

function isCurrentCoordinator(
  principal: BrowserSurfacePrincipal,
  workspace: MaestroBrowserSurfaceRequest['workspace'],
  generation: number
): boolean {
  return canConsumeMaestroIntent(principal, workspace, generation)
}

function requireActiveWorkerDispatch(
  principal: BrowserSurfacePrincipal,
  workspace: MaestroBrowserSurfaceRequest['workspace'],
  generation: number,
  context: RpcContext
) {
  const database = context.runtime.getOrchestrationDb()
  const run = database.getRun(workspace.run_id)
  const dispatch = database.getActiveDispatchForIdentity(principal.actor_id)
  if (
    principal.kind !== 'worker' ||
    !run ||
    run.consumer_generation !== generation ||
    !dispatch ||
    dispatch.run_id !== workspace.run_id
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'Browser surfaces require the current coordinator or the exact active worker Dispatch.'
    )
  }
  return dispatch
}

export function requireBrowserSurfaceCreateAuthority(
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>,
  request: MaestroBrowserSurfaceRequest,
  context: RpcContext
): void {
  requireActiveBrowserProfileConsent(
    request.profile_id,
    request.profile_consent_receipt,
    {
      run_id: request.workspace.run_id,
      task_id: request.task_id,
      attempt_id: request.attempt_id
    },
    context.runtime.getOrchestrationDb(),
    request.workspace
  )
  if (isCurrentCoordinator(principal, request.workspace, request.coordinator_generation)) {
    return
  }
  const dispatch = requireActiveWorkerDispatch(
    principal,
    request.workspace,
    request.coordinator_generation,
    context
  )
  if (
    request.ownership !== 'harness' ||
    request.task_id !== dispatch.task_id ||
    request.attempt_id !== dispatch.id
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'A worker may create only a harness-owned surface for its exact Task and Dispatch.'
    )
  }
}

export function requireBrowserSurfaceActionAuthority(
  principal: BrowserSurfacePrincipal,
  request: MaestroBrowserSurfaceActionRequest,
  context: RpcContext
): void {
  const record = requireBrowserSurfaceOwnershipAuthority(principal, request, context)
  requireActiveBrowserProfileConsent(
    record.receipt.profile_id,
    request.profile_consent_receipt,
    record.receipt,
    context.runtime.getOrchestrationDb(),
    request.workspace
  )
}

export function requireBrowserSurfaceReleaseAuthority(
  principal: BrowserSurfacePrincipal,
  request: MaestroBrowserSurfaceActionRequest,
  context: RpcContext
): void {
  requireBrowserSurfaceOwnershipAuthority(principal, request, context)
}

function requireBrowserSurfaceOwnershipAuthority(
  principal: BrowserSurfacePrincipal,
  request: MaestroBrowserSurfaceActionRequest,
  context: RpcContext
) {
  const record = requireExactSurface(request, context)
  if (isCurrentCoordinator(principal, request.workspace, request.coordinator_generation)) {
    return record
  }
  const dispatch = requireActiveWorkerDispatch(
    principal,
    request.workspace,
    request.coordinator_generation,
    context
  )
  if (
    record.receipt.owner_principal !== principal.actor_id ||
    record.receipt.ownership !== 'harness' ||
    record.receipt.task_id !== dispatch.task_id ||
    record.receipt.attempt_id !== dispatch.id
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'A worker may manage only the harness-owned browser surface for its active Dispatch.'
    )
  }
  return record
}
