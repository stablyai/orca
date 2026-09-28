// `agentSession.hold` / `agentSession.release` — kept answering for clients that still send them.
//
// A view no longer decides whether an agent runs: a send starts one, and the idle sweep stops it.
// So both are no-ops. `hold` still builds the host, because shipped mobile builds build it through
// `hold` before they subscribe. Delete both, and their allowlist entries, once
// MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION passes every client that still calls them.

import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredCleanupHost
} from './structured-agent-session-gate'
import { HoldParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_HOLD_METHODS = [
  defineMethod({
    name: 'agentSession.hold',
    params: HoldParams,
    handler: async (_params, ctx) => {
      await requireInstalledStructuredHost(ctx)
      return { held: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.release',
    params: HoldParams,
    handler: async (_params, ctx) => {
      requireStructuredCleanupHost(ctx)
      return { released: true as const }
    }
  })
]
