import { defineMethod } from '../../core'
import { structuredCallerFor } from './creation/structured-agent-session-gate'
import {
  AgentPromptListPendingParams,
  AgentPromptRespondParams
} from '../../../../../shared/rpc-contract/agent-prompt-params'
import { AgentPromptService } from '../../../agent-prompt/agent-prompt-service'
import {
  createAgentPromptDirectory,
  type AgentPromptRuntime
} from '../../../agent-prompt/agent-prompt-sources'

const services = new WeakMap<object, AgentPromptService>()

function serviceFor(runtime: AgentPromptRuntime): AgentPromptService {
  const existing = services.get(runtime)
  if (existing) {
    return existing
  }
  const created = new AgentPromptService(createAgentPromptDirectory(runtime))
  services.set(runtime, created)
  return created
}

export const AGENT_PROMPT_METHODS = [
  defineMethod({
    name: 'agentPrompt.listPending',
    permission: 'workspace',
    params: AgentPromptListPendingParams,
    handler: (_params, ctx) => serviceFor(ctx.runtime).listPending()
  }),
  defineMethod({
    name: 'agentPrompt.respond',
    permission: 'workspace',
    params: AgentPromptRespondParams,
    handler: (params, ctx) =>
      serviceFor(ctx.runtime).respond({
        ...params,
        callerKey: structuredCallerFor(ctx).callerKey
      })
  })
]
