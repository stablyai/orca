// The options read surface: what a session reports about itself, and the
// host's stored model catalog behind the picker.
//
// `agentSession.options` answers at rest from the record and the catalog, and
// asks the live provider only when one runs. `agentSession.modelCatalog` deliberately does
// neither — answering from the host store is what lets a picker render while
// an attach is still running. It is additive: an older host answers
// `method_not_found` (or `forbidden` through the mobile allowlist gate), and
// the client keeps its static seed.

import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredHost as requireHost
} from './structured-agent-session-gate'
import { ModelCatalogParams, OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS = [
  defineMethod({
    name: 'agentSession.options',
    params: OptionsParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx)).readOptions(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.modelCatalog',
    params: ModelCatalogParams,
    handler: async ({ worktree, ...params }, ctx) => {
      const catalog = requireHost(ctx).deps.modelCatalog
      if (!catalog) {
        return { origin: 'unknown' as const }
      }
      if (worktree === undefined) {
        return catalog.read(params)
      }
      const workspacePath = await ctx.runtime
        .resolveStructuredAgentSessionLocalWorkspacePath(worktree)
        .catch(() => null)
      return catalog.read({ ...params, workspacePath })
    }
  })
]
