// Keep legacy hold/release no-ops: sends start agents and idle sweep stops them.
// hold still installs the host for shipped mobile clients before subscribe.
// Remove both methods/allowlist entries only when MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION excludes all callers.

import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredCleanupHost
} from './structured-agent-session-gate'
import { HoldParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_HOLD_METHODS = [
  defineMethod({
    name: 'agentSession.hold',
    permission: 'workspace',
    params: HoldParams,
    handler: async (params, ctx) => {
      await requireInstalledStructuredHost(ctx, params.sessionId)
      return { held: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.release',
    permission: 'workspace',
    params: HoldParams,
    handler: async (_params, ctx) => {
      requireStructuredCleanupHost(ctx)
      return { released: true as const }
    }
  })
]
