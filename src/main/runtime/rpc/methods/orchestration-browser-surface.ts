import {
  MaestroBrowserProfileConsentGrantRequestSchema,
  MaestroBrowserProfileConsentRevokeRequestSchema,
  MaestroBrowserSurfaceActionRequestSchema,
  MaestroBrowserSurfaceRequestSchema,
  MAESTRO_BROWSER_EVIDENCE_PROTOCOL,
  type MaestroBrowserProfileConsentGrantRequest
} from '../../../../shared/maestro-browser-surface'
import { browserSurfaceWorktreeSelector } from '../../orchestration/maestro-browser-surface-worktree-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { resolveMaestroPrincipal } from '../maestro-principal'
import { BROWSER_SURFACE_LIFECYCLE_METHODS } from './orchestration-browser-surface-lifecycle'
import {
  capturedSurfaceState,
  observedVisibility,
  persistMaestroBrowserEvidence,
  requireBrowserSurfaceActionAuthority,
  requireBrowserSurfaceCreateAuthority,
  showExactSurface,
  withPanePaintObservation
} from './orchestration-browser-surface-authority'
import { ensureMaestroBrowserSurface } from './orchestration-browser-surface-ensure'

export { ensureMaestroBrowserSurface } from './orchestration-browser-surface-ensure'

function requireHumanProfileConsentPrincipal(
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>
): asserts principal is typeof principal & { kind: 'user' } {
  if (principal.kind !== 'user' || !principal.authenticated) {
    throw new OrchestrationError(
      'unauthorized',
      'Only an authenticated human may grant or revoke Browser profile consent.'
    )
  }
}

function requireProfileConsentGrantScope(
  request: MaestroBrowserProfileConsentGrantRequest,
  context: RpcContext
): void {
  const database = context.runtime.getOrchestrationDb()
  const task = database.getTask(request.task_id)
  const dispatch = database.getDispatchContextById(request.attempt_id)
  if (
    !task ||
    task.run_id !== request.workspace.run_id ||
    !dispatch ||
    dispatch.run_id !== request.workspace.run_id ||
    dispatch.task_id !== request.task_id ||
    !['pending', 'dispatched'].includes(dispatch.status)
  ) {
    throw new OrchestrationError(
      'browser_profile_consent_scope_invalid',
      'Browser profile consent requires an exact active Task and Dispatch.'
    )
  }
  if (Date.parse(request.expires_at) <= Date.now()) {
    throw new OrchestrationError(
      'browser_profile_consent_inactive',
      'Browser profile consent must expire in the future.'
    )
  }
}

export const ORCHESTRATION_BROWSER_SURFACE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.browserProfileConsent.grant',
    params: MaestroBrowserProfileConsentGrantRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireHumanProfileConsentPrincipal(principal)
      requireProfileConsentGrantScope(request, context)
      return context.runtime.getOrchestrationDb().grantMaestroBrowserProfileConsent(request, {
        actor_id: principal.actor_id,
        kind: 'user',
        authenticated: true,
        session_id: principal.session_id
      })
    }
  }),
  defineMethod({
    name: 'orchestration.browserProfileConsent.revoke',
    params: MaestroBrowserProfileConsentRevokeRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireHumanProfileConsentPrincipal(principal)
      return context.runtime.getOrchestrationDb().revokeMaestroBrowserProfileConsent(request)
    }
  }),
  defineMethod({
    name: 'orchestration.browserSurface.ensure',
    params: MaestroBrowserSurfaceRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireBrowserSurfaceCreateAuthority(principal, request, context)
      return ensureMaestroBrowserSurface(
        {
          ...request,
          actor: {
            actor_id: principal.actor_id,
            kind: principal.kind,
            authenticated: true,
            session_id: principal.session_id
          }
        },
        context
      )
    }
  }),
  defineMethod({
    name: 'orchestration.browserSurface.focus',
    params: MaestroBrowserSurfaceActionRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireBrowserSurfaceActionAuthority(principal, request, context)
      const { page, record } = await showExactSurface(request, context)
      const worktree = browserSurfaceWorktreeSelector(request.workspace.workspace_key)
      await context.runtime.activateManagedWorktree(worktree, { navigation: 'host' })
      const switched = await context.runtime.browserTabSwitch({
        page,
        worktree,
        focus: true
      })
      const { shown } = await showExactSurface(request, context, switched.browserPageId)
      return context.runtime
        .getOrchestrationDb()
        .updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => {
          // Why: focus re-observes the pane it just switched to, so a real verdict upgrades the
          // receipt; without one the recorded verdict stands rather than being restamped as fresh.
          const focus_receipt = withPanePaintObservation(
            receipt.focus_receipt,
            switched.focusReceipt
          )
          return {
            ...receipt,
            observed_visibility: observedVisibility(
              shown.tab.active,
              focus_receipt.native_pane_paint
            ),
            focus_receipt: {
              ...focus_receipt,
              requested: true,
              workspace_activated: true,
              exact_page_selected: shown.tab.active
            }
          }
        }).receipt
    }
  }),
  defineMethod({
    name: 'orchestration.browserSurface.capture',
    params: MaestroBrowserSurfaceActionRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireBrowserSurfaceActionAuthority(principal, request, context)
      const { page, record, shown } = await showExactSurface(request, context)
      const worktree = browserSurfaceWorktreeSelector(request.workspace.workspace_key)
      const capture =
        record.receipt.evidence.capture_mode === 'native-full-page'
          ? await context.runtime.browserFullScreenshot({ format: 'png', page, worktree })
          : await context.runtime.browserScreenshot({ format: 'png', page, worktree })
      const artifact = await persistMaestroBrowserEvidence(capture.data, capture.format)
      const now = new Date().toISOString()
      return context.runtime
        .getOrchestrationDb()
        .updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
          ...receipt,
          // Why: a validated native screenshot of the exact page is paint evidence, so it recovers a
          // surface that settled unavailable before the page had a chance to paint.
          state: capturedSurfaceState(receipt),
          observed_visibility: observedVisibility(shown.tab.active, 'painted'),
          focus_receipt: {
            ...receipt.focus_receipt,
            exact_page_selected: shown.tab.active,
            native_pane_paint: 'painted',
            observed_at: now,
            unavailable_reason: null
          },
          evidence_receipt: {
            protocol: MAESTRO_BROWSER_EVIDENCE_PROTOCOL,
            artifact_ref: artifact.artifactRef,
            artifact_hash: artifact.artifactHash,
            format: capture.format,
            dimensions: {
              width: artifact.width,
              height: artifact.height,
              device_scale_factor: receipt.viewport.device_scale_factor
            },
            route_or_component: receipt.evidence.route_or_component,
            state: receipt.evidence.state,
            theme: receipt.evidence.theme,
            source_revision: receipt.evidence.source_revision,
            capture_mode: receipt.evidence.capture_mode,
            captured_at: now,
            vision_review: { outcome: 'pending', reviewer: null, observation: null }
          }
        })).receipt
    }
  }),
  ...BROWSER_SURFACE_LIFECYCLE_METHODS
]
