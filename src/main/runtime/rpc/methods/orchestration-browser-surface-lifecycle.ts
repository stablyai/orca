import {
  MaestroBrowserSurfaceActionRequestSchema,
  MaestroBrowserSurfaceReleaseRequestSchema
} from '../../../../shared/maestro-browser-surface'
import {
  createMaestroBrowserSurfaceReconciliationHost,
  reconcileMaestroBrowserSurface
} from '../../orchestration/maestro-browser-surface-reconciliation'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { resolveMaestroPrincipal } from '../maestro-principal'
import {
  requireBrowserSurfaceActionAuthority,
  requireBrowserSurfaceReleaseAuthority,
  showExactSurface
} from './orchestration-browser-surface-authority'

/** Retain and release preserve exact ownership for the coordinator or active owning worker. */
export const BROWSER_SURFACE_LIFECYCLE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.browserSurface.retain',
    params: MaestroBrowserSurfaceActionRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireBrowserSurfaceActionAuthority(principal, request, context)
      const { record } = await showExactSurface(request, context)
      return context.runtime
        .getOrchestrationDb()
        .updateMaestroBrowserSurface(record.receipt.surface_id, (receipt) => ({
          ...receipt,
          retention: 'retain',
          state: 'retained'
        })).receipt
    }
  }),
  defineMethod({
    name: 'orchestration.browserSurface.release',
    params: MaestroBrowserSurfaceReleaseRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireBrowserSurfaceReleaseAuthority(principal, request, context)
      const database = context.runtime.getOrchestrationDb()
      const record = database.getMaestroBrowserSurface(request.surface_id)
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
      const pending = database.updateMaestroBrowserSurface(request.surface_id, (receipt) => ({
        ...receipt,
        state: 'release_pending',
        release_receipt: {
          ...receipt.release_receipt,
          requested: true,
          reason: request.reason
        }
      }))
      return (
        await reconcileMaestroBrowserSurface(
          database,
          pending,
          createMaestroBrowserSurfaceReconciliationHost(context.runtime)
        )
      ).receipt
    }
  })
]
