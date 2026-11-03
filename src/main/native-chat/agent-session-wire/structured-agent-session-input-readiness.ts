import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'

/** Queue conversion and provider handoff use the same live child acceptance rule. */
export function structuredAgentSessionChildAcceptsInput(input: {
  child: StructuredAgentSessionProviderChild | null | undefined
  current: boolean
  stopping: boolean
  work: StructuredAgentSessionCurrentWork | null
}): boolean {
  return Boolean(
    input.current &&
    input.child?.phase === 'ready' &&
    !input.child.close &&
    !input.stopping &&
    !(input.work && structuredAgentSessionCommandRunning(input.work))
  )
}
