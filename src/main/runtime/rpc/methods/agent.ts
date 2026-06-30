import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const AgentLabelSet = z.object({
  terminal: requiredString('Missing terminal handle'),
  // Why: OptionalString coerces non-string or empty-string inputs to undefined
  // (a no-op, never an error), which the handler then treats as a clear via
  // `params.label ?? null`. A real label is a non-empty string.
  label: OptionalString
})

const AgentLabelClear = z.object({
  terminal: requiredString('Missing terminal handle')
})

// Why: per-agent custom sidebar label commands. Co-located in their own `agent`
// namespace (rather than `terminal`) because the label targets the agent in a
// pane, not the terminal tab title — a separate concept from terminal.rename.
export const AGENT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'agent.label.set',
    params: AgentLabelSet,
    handler: async (params, { runtime }) => ({
      label: await runtime.setCustomAgentLabel(params.terminal, params.label ?? null)
    })
  }),
  defineMethod({
    name: 'agent.label.clear',
    params: AgentLabelClear,
    handler: async (params, { runtime }) => ({
      label: await runtime.setCustomAgentLabel(params.terminal, null)
    })
  })
]
