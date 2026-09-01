import type {
  AgentLaunchFailureCode,
  AgentLaunchRequestError
} from '../../../src/shared/agent-launch-contract'
import type { TerminalCreateResult } from './mobile-session-route-types'

export function readMobileNewTabCreatedTerminal(result: unknown): TerminalCreateResult['tab'] {
  const envelope = result as {
    tab?: TerminalCreateResult['tab']
    agentLaunch?:
      | { status: 'failed'; failure: { code: AgentLaunchFailureCode } }
      | { status: 'rejected'; requestError: AgentLaunchRequestError }
  } | null
  if (envelope?.tab) {
    return envelope.tab
  }
  if (envelope?.agentLaunch?.status === 'failed') {
    throw new Error(`Couldn't start the agent (${envelope.agentLaunch.failure.code}).`)
  }
  if (envelope?.agentLaunch?.status === 'rejected') {
    throw new Error(`Couldn't create the terminal (${envelope.agentLaunch.requestError.code}).`)
  }
  throw new Error('Created terminal response was invalid')
}
