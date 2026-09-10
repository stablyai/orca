import type { MaestroBrowserSurfaceReceipt } from '../../../shared/maestro-browser-surface'
import type { OrchestrationDb } from './db/orchestration-db'
import type { MaestroBrowserSurfaceRecord } from './db/maestro-browser-surface/maestro-browser-surface-store'
import {
  browserSurfaceObservedWorkspaceKey,
  browserSurfaceWorktreeSelector
} from './maestro-browser-surface-worktree-identity'
import { OrchestrationError } from './orchestration-error'

type MaestroBrowserSurfaceRuntime = {
  browserTabShow: (options: { page: string; worktree: string }) => Promise<{
    tab: {
      browserPageId: string
      worktreeId?: string | null
      profileId?: string | null
      active: boolean
    }
  }>
  browserTabClose: (options: { page: string; worktree: string }) => Promise<unknown>
}

export type MaestroBrowserPageObservation = {
  verdict: 'live' | 'unverifiable' | 'exited'
  executionHostId: string
  workspaceKey: string
  browserPageId: string
  profileId: string | null
  visible: boolean
  paintable: boolean
}

export type MaestroBrowserSurfaceReconciliationHost = {
  observePage: (receipt: MaestroBrowserSurfaceReceipt) => Promise<MaestroBrowserPageObservation>
  closePage: (receipt: MaestroBrowserSurfaceReceipt) => Promise<MaestroBrowserPageObservation>
}

function browserSurfaceErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }
  return typeof error.code === 'string' ? error.code : null
}

function pageObservation(
  receipt: MaestroBrowserSurfaceReceipt,
  tab: Awaited<ReturnType<MaestroBrowserSurfaceRuntime['browserTabShow']>>['tab']
): MaestroBrowserPageObservation {
  return {
    verdict: 'live',
    executionHostId: receipt.execution_host_id,
    workspaceKey: browserSurfaceObservedWorkspaceKey(tab.worktreeId, receipt.workspace_key),
    browserPageId: tab.browserPageId,
    profileId: tab.profileId ?? null,
    visible: receipt.focus_receipt.exact_page_selected && tab.active,
    paintable: receipt.focus_receipt.native_pane_paint === 'painted'
  }
}

export function createMaestroBrowserSurfaceReconciliationHost(
  runtime: MaestroBrowserSurfaceRuntime
): MaestroBrowserSurfaceReconciliationHost {
  return {
    observePage: async (receipt) => {
      if (!receipt.browser_page_id) {
        return {
          verdict: 'unverifiable',
          executionHostId: receipt.execution_host_id,
          workspaceKey: receipt.workspace_key,
          browserPageId: '',
          profileId: receipt.profile_id,
          visible: false,
          paintable: false
        }
      }
      try {
        const result = await runtime.browserTabShow({
          page: receipt.browser_page_id,
          worktree: browserSurfaceWorktreeSelector(receipt.workspace_key)
        })
        return pageObservation(receipt, result.tab)
      } catch (error) {
        return {
          verdict:
            browserSurfaceErrorCode(error) === 'browser_tab_not_found' ? 'exited' : 'unverifiable',
          executionHostId: receipt.execution_host_id,
          workspaceKey: receipt.workspace_key,
          browserPageId: receipt.browser_page_id,
          profileId: receipt.profile_id,
          visible: false,
          paintable: false
        }
      }
    },
    closePage: async (receipt) => {
      if (!receipt.browser_page_id) {
        throw new OrchestrationError(
          'browser_surface_identity_missing',
          'The page identity is missing.'
        )
      }
      await runtime.browserTabClose({
        page: receipt.browser_page_id,
        worktree: browserSurfaceWorktreeSelector(receipt.workspace_key)
      })
      return {
        verdict: 'exited',
        executionHostId: receipt.execution_host_id,
        workspaceKey: receipt.workspace_key,
        browserPageId: receipt.browser_page_id,
        profileId: receipt.profile_id,
        visible: false,
        paintable: false
      }
    }
  }
}

function identityMatches(
  receipt: MaestroBrowserSurfaceReceipt,
  observation: MaestroBrowserPageObservation
): boolean {
  return (
    receipt.execution_host_id === observation.executionHostId &&
    receipt.workspace_key === observation.workspaceKey &&
    receipt.browser_page_id === observation.browserPageId &&
    receipt.profile_id === observation.profileId
  )
}

function unavailable(
  database: OrchestrationDb,
  record: MaestroBrowserSurfaceRecord,
  reason: string
): MaestroBrowserSurfaceRecord {
  return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
    ...receipt,
    state: receipt.state === 'release_pending' ? 'outcome_unknown' : 'unavailable',
    observed_visibility: 'unverifiable',
    focus_receipt: {
      ...receipt.focus_receipt,
      native_pane_paint: 'unobserved',
      observed_at: null,
      unavailable_reason: reason
    }
  }))
}

export async function reconcileMaestroBrowserSurface(
  database: OrchestrationDb,
  record: MaestroBrowserSurfaceRecord,
  host: MaestroBrowserSurfaceReconciliationHost
): Promise<MaestroBrowserSurfaceRecord> {
  if (!record.receipt.browser_page_id) {
    return unavailable(database, record, 'The reserved browser page has no durable identity.')
  }

  let observation: MaestroBrowserPageObservation
  try {
    observation = await host.observePage(record.receipt)
  } catch {
    return unavailable(database, record, 'The owning browser host is unreachable.')
  }
  if (!identityMatches(record.receipt, observation)) {
    return unavailable(database, record, 'The observed page identity does not match the lease.')
  }
  if (observation.verdict === 'unverifiable') {
    return unavailable(database, record, 'The owning browser host cannot verify the page.')
  }
  if (observation.verdict === 'exited') {
    return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
      ...receipt,
      state: 'released',
      observed_visibility: 'unavailable',
      release_receipt: {
        ...receipt.release_receipt,
        outcome: receipt.release_receipt.requested ? 'released' : 'not_requested',
        exact_page_closed: receipt.release_receipt.requested,
        observed_at: new Date().toISOString()
      }
    }))
  }

  if (record.receipt.state !== 'release_pending') {
    return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
      ...receipt,
      state: receipt.retention === 'retain' ? 'retained' : 'active',
      observed_visibility: observation.visible
        ? observation.paintable
          ? 'visible'
          : 'hidden'
        : 'offscreen',
      // Why: reconciliation observes selection, not paint — it carries the recorded paint verdict
      // and its observation time forward instead of restamping one it never took.
      focus_receipt: {
        ...receipt.focus_receipt,
        exact_page_selected: observation.visible
      }
    }))
  }

  if (record.receipt.ownership !== 'harness') {
    return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
      ...receipt,
      state: 'retained',
      release_receipt: {
        ...receipt.release_receipt,
        outcome: 'not_owned',
        exact_page_closed: false,
        observed_at: new Date().toISOString(),
        reason: 'User-owned browser pages are read-only to Harness cleanup.'
      }
    }))
  }
  if (record.receipt.retention === 'retain') {
    return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
      ...receipt,
      state: 'retained',
      release_receipt: {
        ...receipt.release_receipt,
        outcome: 'retained',
        exact_page_closed: false,
        observed_at: new Date().toISOString(),
        reason: 'The browser surface retention policy preserves this page.'
      }
    }))
  }

  let closeObservation: MaestroBrowserPageObservation
  try {
    closeObservation = await host.closePage(record.receipt)
  } catch {
    return unavailable(database, record, 'The exact page close outcome is unverifiable.')
  }
  if (!identityMatches(record.receipt, closeObservation) || closeObservation.verdict !== 'exited') {
    return unavailable(
      database,
      record,
      'The exact page close was not observed by its owning host.'
    )
  }
  return database.updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
    ...receipt,
    state: 'released',
    observed_visibility: 'unavailable',
    release_receipt: {
      ...receipt.release_receipt,
      outcome: 'released',
      exact_page_closed: true,
      observed_at: new Date().toISOString(),
      reason: null
    }
  }))
}

export async function reconcileMaestroBrowserSurfaces(
  database: OrchestrationDb,
  host: MaestroBrowserSurfaceReconciliationHost
): Promise<MaestroBrowserSurfaceRecord[]> {
  const records = database.listReconcilableMaestroBrowserSurfaces()
  const results: MaestroBrowserSurfaceRecord[] = []
  for (const record of records) {
    results.push(await reconcileMaestroBrowserSurface(database, record, host))
  }
  return results
}
