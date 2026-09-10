import type {
  MaestroBrowserPanePaint,
  MaestroBrowserSurfaceReceipt,
  MaestroBrowserSurfaceRequest
} from '../../../../shared/maestro-browser-surface'
import {
  browserSurfaceWorktreeId,
  browserSurfaceWorktreeSelector
} from '../../orchestration/maestro-browser-surface-worktree-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RpcContext } from '../core'
import { browserSurfaceIdentityMismatch } from './orchestration-browser-surface-observation'
import {
  fileErrorCode,
  NO_PANE_PAINT_REASON,
  observedVisibility,
  persistMaestroBrowserEvidence,
  requireActiveBrowserProfileConsent,
  UNOBSERVED_PANE_PAINT_REASON
} from './orchestration-browser-surface-authority'

function requireExactReturnedPage(
  receipt: MaestroBrowserSurfaceReceipt,
  tab: { browserPageId: string; worktreeId?: string | null; profileId?: string | null }
): string {
  if (
    tab.browserPageId !== receipt.browser_page_id ||
    (tab.worktreeId !== null &&
      tab.worktreeId !== browserSurfaceWorktreeId(receipt.workspace_key)) ||
    (tab.profileId ?? null) !== receipt.profile_id
  ) {
    throw browserSurfaceIdentityMismatch(
      {
        browserPageId: receipt.browser_page_id,
        worktreeId: browserSurfaceWorktreeId(receipt.workspace_key),
        profileId: receipt.profile_id
      },
      {
        browserPageId: tab.browserPageId,
        worktreeId: tab.worktreeId ?? null,
        profileId: tab.profileId ?? null
      }
    )
  }
  return tab.browserPageId
}

export async function ensureMaestroBrowserSurface(
  request: MaestroBrowserSurfaceRequest,
  context: RpcContext
): Promise<MaestroBrowserSurfaceReceipt> {
  const database = context.runtime.getOrchestrationDb()
  requireActiveBrowserProfileConsent(
    request.profile_id,
    request.profile_consent_receipt,
    {
      run_id: request.workspace.run_id,
      task_id: request.task_id,
      attempt_id: request.attempt_id
    },
    database,
    request.workspace
  )
  const reserved = database.reserveMaestroBrowserSurface(request)
  if (['active', 'retained', 'released'].includes(reserved.receipt.state)) {
    return reserved.receipt
  }
  const creating = database.updateMaestroBrowserSurface(reserved.receipt.surface_id, (receipt) => ({
    ...receipt,
    state: 'creating'
  }))
  const pageId = creating.receipt.browser_page_id
  if (!pageId) {
    throw new OrchestrationError(
      'browser_surface_identity_missing',
      'The browser surface reservation has no page identity.'
    )
  }

  const worktree = browserSurfaceWorktreeSelector(request.workspace.workspace_key)
  let created = false
  let returnedPage = pageId
  try {
    const shown = await context.runtime.browserTabShow({ page: returnedPage, worktree })
    returnedPage = requireExactReturnedPage(creating.receipt, shown.tab)
  } catch (error) {
    if (fileErrorCode(error) !== 'browser_tab_not_found') {
      throw error
    }
    if (request.ownership === 'user') {
      return database.updateMaestroBrowserSurface(creating.receipt.surface_id, (receipt) => ({
        ...receipt,
        state: 'unavailable',
        observed_visibility: 'unavailable',
        focus_receipt: {
          ...receipt.focus_receipt,
          unavailable_reason: 'The user-owned page is not available on its exact workspace.'
        }
      })).receipt
    }
    created = true
  }

  let workspaceActivated = false
  if (request.requested_visibility === 'visible') {
    await context.runtime.activateManagedWorktree(worktree, { navigation: 'host' })
    workspaceActivated = true
  }
  const createResult = created
    ? await context.runtime.browserTabCreate({
        url: creating.navigationUrl,
        worktree,
        page: pageId,
        profileId: request.profile_id ?? undefined,
        waitForRegistration: true,
        activate: request.requested_visibility === 'visible',
        focus: request.requested_visibility === 'visible'
      })
    : null
  if (createResult) {
    returnedPage = createResult.browserPageId
  }
  if (!created && request.requested_visibility === 'visible') {
    const switched = await context.runtime.browserTabSwitch({
      page: returnedPage,
      worktree,
      focus: true
    })
    returnedPage = switched.browserPageId
  }
  const shown = await context.runtime.browserTabShow({ page: returnedPage, worktree })
  const page = requireExactReturnedPage(creating.receipt, shown.tab)
  const focusReceipt = createResult?.focusReceipt
  const requestedVisible = request.requested_visibility === 'visible'
  const exactPageSelected =
    requestedVisible && (focusReceipt?.exactPageSelected ?? shown.tab.active)
  // Why: an offscreen surface never asked for a pane probe, so its paint is unobserved.
  const panePaint: MaestroBrowserPanePaint = requestedVisible
    ? (focusReceipt?.nativePanePaint ?? 'unobserved')
    : 'unobserved'
  const panePaintObservedAt = panePaint === 'unobserved' ? null : (focusReceipt?.observedAt ?? null)
  if (requestedVisible && panePaint !== 'painted') {
    return database.updateMaestroBrowserSurface(creating.receipt.surface_id, (receipt) => ({
      ...receipt,
      state: 'unavailable',
      observed_visibility: observedVisibility(shown.tab.active, panePaint),
      focus_receipt: {
        requested: true,
        workspace_activated: workspaceActivated,
        exact_page_selected: exactPageSelected,
        native_pane_paint: panePaint,
        observed_at: panePaintObservedAt,
        unavailable_reason:
          panePaint === 'unobserved' ? UNOBSERVED_PANE_PAINT_REASON : NO_PANE_PAINT_REASON
      }
    })).receipt
  }

  const capture =
    request.evidence.capture_mode === 'native-full-page'
      ? await context.runtime.browserFullScreenshot({ format: 'png', page, worktree })
      : await context.runtime.browserScreenshot({ format: 'png', page, worktree })
  const artifact = await persistMaestroBrowserEvidence(capture.data, capture.format)
  const now = new Date().toISOString()
  return database.updateMaestroBrowserSurface(creating.receipt.surface_id, (receipt) => ({
    ...receipt,
    state: request.retention === 'retain' ? 'retained' : 'active',
    observed_visibility: request.requested_visibility,
    focus_receipt: {
      requested: requestedVisible,
      workspace_activated: workspaceActivated,
      exact_page_selected: exactPageSelected,
      native_pane_paint: panePaint,
      observed_at: panePaintObservedAt,
      unavailable_reason: null
    },
    evidence_receipt: {
      protocol: 'maestro-browser-evidence/v1',
      artifact_ref: artifact.artifactRef,
      artifact_hash: artifact.artifactHash,
      format: capture.format,
      dimensions: {
        width: artifact.width,
        height: artifact.height,
        device_scale_factor: request.viewport.device_scale_factor
      },
      route_or_component: request.evidence.route_or_component,
      state: request.evidence.state,
      theme: request.evidence.theme,
      source_revision: request.evidence.source_revision,
      capture_mode: request.evidence.capture_mode,
      captured_at: now,
      vision_review: { outcome: 'pending', reviewer: null, observation: null }
    }
  })).receipt
}
