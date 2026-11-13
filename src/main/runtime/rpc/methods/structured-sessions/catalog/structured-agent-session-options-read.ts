import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
// options reads at-rest records/catalogs or the live provider; modelCatalog reads stored/start-published facts without waiting on attach.
// Older hosts return method_not_found (mobile may see forbidden); clients retain static seeds.

import { defineMethod } from '../../../core'
import { withTimeout } from '../../../../../../shared/promise-timeout-fallback'
import { isFloatingWorkspaceSelector } from '../../../../../../shared/floating-workspace-worktree'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-listing-waiters'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience
} from '../creation/structured-agent-session-gate'
import {
  HandoffStatusParams,
  ModelCatalogParams,
  OptionsParams
} from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-queued-edit-params'
import { ContinuationContextParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-identifiers'
import { agentSessionPinnedLaunchDirectory } from '../../../../agent-session/records/agent-session-record-launch-directory'
import {
  clientRequestsCommands,
  clientReadsOptionsWithoutModel
} from '../structured-agent-session-policy'
import type { AgentSessionModelCatalogResult } from '../../../../../../shared/agent-session/agent-session-wire'
import { structuredAgentSessionOptionModels } from '../../../../../native-chat/agent-session-wire/options/structured-agent-session-option-models'
import { finishedListingIds } from '../../../../../../shared/agent-session/options/structured-agent-session-listing-verified-ids'

export const STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS = [
  defineMethod({
    name: 'agentSession.continuationContext',
    permission: 'workspace',
    params: ContinuationContextParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).continuationContext(params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    permission: 'workspace',
    params: HandoffStatusParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).readCommands(
        params.sessionId,
        clientRequestsCommands(ctx)
      )
  }),
  defineMethod({
    name: 'agentSession.options',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const readsWithoutModel = clientReadsOptionsWithoutModel(ctx)
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const options = await host.readOptions(params.sessionId, { readsWithoutModel })
      const conversation = host.deps.store.getConversation(params.sessionId)
      const result = { ...options, sessionNeverStarted: conversation?.neverStarted }
      if (result.current.model === undefined && !readsWithoutModel) {
        return {
          ...result,
          current: { ...result.current, model: '' },
          models: [
            { id: '', label: 'Model not reported', isDefault: false, efforts: [] },
            ...result.models.filter((model) => model.id !== '')
          ]
        }
      }
      return result
    }
  }),
  defineMethod({
    name: 'agentSession.modelCatalog',
    permission: 'workspace',
    params: ModelCatalogParams,
    // Session reads may build the host; session-less terminal reads must not open unused structured journals.
    handler: async ({ worktree, ...params }, ctx) => {
      requireStructuredAgentAudience(ctx, params.agent)
      const host =
        params.sessionId === undefined
          ? null
          : await requireInstalledStructuredHost(ctx, params.sessionId)
      const record =
        params.sessionId === undefined ? null : host?.deps.store.getConversation(params.sessionId)
      const coherent =
        ctx.clientKind === undefined ||
        ctx.clientCapabilities?.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY) === true
      const scope = coherent ? {} : { legacy: true }
      const read = async (): Promise<AgentSessionModelCatalogResult> => {
        const catalog = host
          ? host.deps.modelCatalog
          : await ctx.runtime.structuredAgentModelCatalog()
        if (!catalog) {
          return { origin: 'unknown' }
        }
        // A floating chat runs in the folder it was created in, not the floating setting's current one.
        const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
        const waits = !params.savedOnly && params.waitForListing === true
        const deadline = Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
        // Only a floating folder touches the filesystem; a read that doesn't wait never waits on it.
        const resolving =
          launchDirectory || worktree === undefined
            ? undefined
            : ctx.runtime.resolveStructuredAgentCatalogWorkspacePath(worktree)
        const later = !waits && isFloatingWorkspaceSelector(worktree)
        const request = {
          ...params,
          ...scope,
          ...(waits && resolving ? { deadline } : {}),
          ...(launchDirectory
            ? { workspacePath: launchDirectory }
            : !resolving
              ? {}
              : {
                  // Past the read's own budget, a stalled mount reads as a workspace this host
                  // can't inspect: no default and no exact listing.
                  workspacePath: later
                    ? null
                    : await withTimeout(resolving, Math.max(0, deadline - Date.now()), null)
                })
        }
        const follows = later && resolving && !params.savedOnly
        if (follows) {
          // The listing for the folder it resolves to starts once it does, inside this read's own
          // budget and retirement; the answer says so, so the picker follows with a waiting read.
          const operation = catalog.captureRead({ ...request, deadline })
          void withTimeout(resolving, Math.max(0, deadline - Date.now()), null).then(
            (workspacePath) => {
              if (workspacePath && operation.current()) {
                void catalog.demand({ ...request, workspacePath, deadline, operation })
              }
            }
          )
        }
        // A floating read lists the folder it resolves to (above), never the unresolved one.
        if (!host && !params.savedOnly && !follows) {
          void catalog.demand(request)
        }
        const result = host ? await host.readModelCatalog(request) : await catalog.read(request)
        return follows ? { ...result, listingInProgress: true } : result
      }
      const listing = await read()
      const own = record?.provider === params.agent ? record : null
      // Preserve a reopened chat's own model even if unlisted; new-chat reads instead seed the next picker.
      return !coherent &&
        own &&
        worktree === undefined &&
        finishedListingIds(listing) &&
        listing.origin !== 'unknown'
        ? {
            ...listing,
            models: structuredAgentSessionOptionModels(
              listing.models,
              own.options?.model,
              (row) => row
            )
          }
        : listing
    }
  })
]
