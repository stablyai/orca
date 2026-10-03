import type { CommandHandler } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import { buildAgentContext, formatAgentContextSummary } from '../agent-context'
import { buildAgentContextQuery, formatAgentContextQuery } from '../agent-context-query'
import { parseAgentContextRequest } from '../agent-context-query-request'

export const INTROSPECTION_HANDLERS: Record<string, CommandHandler> = {
  // Why: local registry reads keep agent discovery available over SSH and headless sessions.
  'agent-context': async ({ flags, json }) => {
    const request = parseAgentContextRequest(flags, json)
    if (request.query) {
      const schema = buildAgentContextQuery(COMMAND_SPECS, request.query)
      console.log(
        json
          ? JSON.stringify(schema, null, request.compact ? undefined : 2)
          : formatAgentContextQuery(schema)
      )
      return
    }
    const schema = buildAgentContext(COMMAND_SPECS)
    if (json) {
      console.log(JSON.stringify(schema, null, request.compact ? undefined : 2))
      return
    }
    console.log(formatAgentContextSummary(schema))
  }
}
