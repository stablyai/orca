import type { CommandHandler } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import { buildAgentContext, formatAgentContextSummary } from '../agent-context'

export const INTROSPECTION_HANDLERS: Record<string, CommandHandler> = {
  // Why: pure local command — reads the static spec registry and prints it, with
  // no runtime RPC, so it works when the Orca app is not running (SSH/headless).
  'agent-context': async ({ json }) => {
    const schema = buildAgentContext(COMMAND_SPECS)
    if (json) {
      console.log(JSON.stringify(schema, null, 2))
      return
    }
    console.log(formatAgentContextSummary(schema))
  }
}
