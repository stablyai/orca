import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { readRasterImageDimensions } from '../../../../shared/raster-image-dimensions'
import type {
  MaestroBrowserFocusReceipt,
  MaestroBrowserPanePaint,
  MaestroBrowserSurfaceActionRequest,
  MaestroBrowserSurfaceReceipt
} from '../../../../shared/maestro-browser-surface'
import {
  browserSurfaceWorktreeId,
  browserSurfaceWorktreeSelector
} from '../../orchestration/maestro-browser-surface-worktree-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RpcContext } from '../core'

type BrowserSurfaceIdentity = {
  browserPageId: string | null
  worktreeId: string | null
  profileId: string | null
}

export function browserSurfaceIdentityMismatch(
  expected: BrowserSurfaceIdentity,
  observed: BrowserSurfaceIdentity
): OrchestrationError {
  const differences = (['browserPageId', 'worktreeId', 'profileId'] as const).filter(
    (field) => expected[field] !== observed[field]
  )
  return new OrchestrationError(
    'browser_surface_identity_mismatch',
    `The native Browser page differs from the reserved surface in: ${differences.join(', ')}.`,
    { expected, observed, differences }
  )
}

export function requireExactSurface(
  request: MaestroBrowserSurfaceActionRequest,
  context: RpcContext
) {
  const record = context.runtime.getOrchestrationDb().getMaestroBrowserSurface(request.surface_id)
  if (!record) {
    throw new OrchestrationError(
      'browser_surface_not_found',
      `Browser surface ${request.surface_id} was not found.`
    )
  }
  if (
    record.receipt.run_id !== request.workspace.run_id ||
    record.receipt.execution_host_id !== request.workspace.execution_host_id ||
    record.receipt.workspace_key !== request.workspace.workspace_key
  ) {
    throw new OrchestrationError(
      'browser_surface_identity_mismatch',
      'The browser surface does not belong to this run and workspace.'
    )
  }
  if (!record.receipt.browser_page_id) {
    throw new OrchestrationError(
      'browser_surface_identity_missing',
      'The browser surface has no page identity.'
    )
  }
  return record
}

export function observedVisibility(
  active: boolean,
  paint: MaestroBrowserPanePaint
): MaestroBrowserSurfaceReceipt['observed_visibility'] {
  if (!active) {
    return 'offscreen'
  }
  // Why: never-observed is not the same answer as observed-and-blank, so it keeps its own verdict.
  if (paint === 'unobserved') {
    return 'unverifiable'
  }
  return paint === 'painted' ? 'visible' : 'hidden'
}

export const NO_PANE_PAINT_REASON = 'The exact native Browser pane produced no paint.'
export const UNOBSERVED_PANE_PAINT_REASON =
  'The exact native Browser pane has not been observed for paint yet.'

/** A genuine new observation replaces the recorded verdict; no observation leaves it untouched. */
export function withPanePaintObservation(
  focusReceipt: MaestroBrowserFocusReceipt,
  observed: { nativePanePaint: MaestroBrowserPanePaint; observedAt: string | null } | undefined
): MaestroBrowserFocusReceipt {
  if (!observed || observed.nativePanePaint === 'unobserved') {
    return focusReceipt
  }
  return {
    ...focusReceipt,
    native_pane_paint: observed.nativePanePaint,
    observed_at: observed.observedAt,
    unavailable_reason: observed.nativePanePaint === 'painted' ? null : NO_PANE_PAINT_REASON
  }
}

// Why: a capture is evidence, not a release decision, so it preserves the release lifecycle.
const RELEASE_LIFECYCLE_STATES: ReadonlySet<MaestroBrowserSurfaceReceipt['state']> = new Set([
  'release_pending',
  'released',
  'outcome_unknown'
])

export function capturedSurfaceState(
  receipt: MaestroBrowserSurfaceReceipt
): MaestroBrowserSurfaceReceipt['state'] {
  if (RELEASE_LIFECYCLE_STATES.has(receipt.state)) {
    return receipt.state
  }
  return receipt.retention === 'retain' ? 'retained' : 'active'
}

export async function showExactSurface(
  request: MaestroBrowserSurfaceActionRequest,
  context: RpcContext,
  returnedPage?: string
) {
  const record = requireExactSurface(request, context)
  const page = returnedPage ?? record.receipt.browser_page_id
  if (!page) {
    throw new OrchestrationError(
      'browser_surface_identity_missing',
      'The browser surface has no page identity.'
    )
  }
  if (page !== record.receipt.browser_page_id) {
    throw browserSurfaceIdentityMismatch(
      {
        browserPageId: record.receipt.browser_page_id,
        worktreeId: browserSurfaceWorktreeId(record.receipt.workspace_key),
        profileId: record.receipt.profile_id
      },
      { browserPageId: page, worktreeId: null, profileId: null }
    )
  }
  const worktreeId = browserSurfaceWorktreeId(request.workspace.workspace_key)
  const shown = await context.runtime.browserTabShow({
    page,
    worktree: browserSurfaceWorktreeSelector(request.workspace.workspace_key)
  })
  if (
    shown.tab.browserPageId !== record.receipt.browser_page_id ||
    (shown.tab.worktreeId !== null && shown.tab.worktreeId !== worktreeId) ||
    (shown.tab.profileId ?? null) !== record.receipt.profile_id
  ) {
    throw browserSurfaceIdentityMismatch(
      {
        browserPageId: record.receipt.browser_page_id,
        worktreeId,
        profileId: record.receipt.profile_id
      },
      {
        browserPageId: shown.tab.browserPageId,
        worktreeId: shown.tab.worktreeId ?? null,
        profileId: shown.tab.profileId ?? null
      }
    )
  }
  return { page: shown.tab.browserPageId, record, shown }
}

export function fileErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }
  return typeof error.code === 'string' ? error.code : null
}

export async function persistMaestroBrowserEvidence(data: string, format: 'png' | 'jpeg') {
  const bytes = Buffer.from(data, 'base64')
  const dimensions = readRasterImageDimensions(bytes)
  if (!dimensions) {
    throw new OrchestrationError(
      'browser_surface_capture_invalid',
      'The native Browser capture did not contain a valid image.'
    )
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const directory = join(
    getAppEnvironment().getPath('userData'),
    'maestro-browser-evidence',
    'sha256'
  )
  const filename = `${hash}.${format === 'jpeg' ? 'jpg' : 'png'}`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (fileErrorCode(error) !== 'EEXIST') {
      throw error
    }
  }
  return {
    artifactRef: `artifact:maestro-browser-evidence/sha256/${filename}`,
    artifactHash: `sha256:${hash}` as const,
    width: dimensions.width,
    height: dimensions.height
  }
}
