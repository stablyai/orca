// The options read surface: what a session reports about itself, and the
// host's stored model catalog behind the picker.
//
// `agentSession.options` answers at rest from the record and the catalog, and
// asks the live provider only when one runs. `agentSession.modelCatalog` deliberately does
// neither — answering from the host store (and what a running child's start already said) is
// what lets a picker render while an attach is still running. It is additive: an older host answers
// `method_not_found` (or `forbidden` through the mobile allowlist gate), and
// the client keeps its static seed.

import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience,
  requireStructuredHost
} from './structured-agent-session-gate'
import {
  HandoffStatusParams,
  ModelCatalogParams,
  OptionsParams
} from './structured-agent-session-schemas'
import { agentSessionPinnedLaunchDirectory } from '../../agent-session-record-launch-directory'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { clientReadsOptionsWithoutModel } from './structured-agent-session-policy'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'

export const STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS = [
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
      (await requireInstalledStructuredHost(ctx, params.sessionId)).readCommands(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.options',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const result = await (
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).readOptions(params.sessionId)
      if (result.current.model === undefined && !clientReadsOptionsWithoutModel(ctx)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      return result
    }
  }),
  defineMethod({
    name: 'agentSession.modelCatalog',
    permission: 'workspace',
    params: ModelCatalogParams,
    // A structured chat's read names its session and builds the host, since it may come first;
    // terminal-backed chat's session-less read must not open the journal where none runs.
    handler: async ({ worktree, ...params }, ctx) => {
      requireStructuredAgentAudience(ctx, params.agent)
      const host =
        params.sessionId === undefined
          ? requireStructuredHost(ctx)
          : await requireInstalledStructuredHost(ctx, params.sessionId)
      const record =
        params.sessionId === undefined ? null : host.deps.store.getRecord(params.sessionId)
      const read = async (): Promise<AgentSessionModelCatalogResult> => {
        const catalog = host.deps.modelCatalog
        if (!catalog) {
          return { origin: 'unknown' }
        }
        // A floating chat runs in the folder it was created in, not the floating setting's current one.
        const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
        if (launchDirectory) {
          return catalog.read({ ...params, workspacePath: launchDirectory })
        }
        if (worktree === undefined) {
          return catalog.read(params)
        }
        const workspacePath = await ctx.runtime
          .resolveStructuredAgentSessionLocalWorkspacePath(worktree)
          .catch(() => null)
        return catalog.read({ ...params, workspacePath })
      }
      const answer = await read()
      // The chat's running agent can say what no listing does: a Pi that started with no model.
      const started =
        record?.provider === params.agent
          ? host.deps.adapter.startUnavailable?.(record.sessionId)
          : undefined
      return started && !answer.unavailable ? { ...answer, unavailable: started } : answer
    }
  })
]
