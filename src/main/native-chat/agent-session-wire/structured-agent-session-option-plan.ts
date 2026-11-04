import type { AgentSessionOptionResult } from '../../../shared/agent-session/agent-session-wire'
import { readNoChoiceOptionResult } from './structured-agent-session-option-observation'
import type { MutationPlan } from './structured-agent-session-mutation-plans'

export function setOptionPlan(params: { key: string; value: string }) {
  return {
    method: 'agentSession.setOption',
    fields: { key: params.key, value: params.value },
    run: async (ctx) => {
      const options = { ...ctx.persistedOptions, [params.key]: params.value }
      await ctx.persistOptions(options)
      ctx.publish()
      return { ok: true, value: { ...params, options } }
    },
    // Reapply unsettled picks; only a settled success can be replayed directly.
    replay: (ctx, outcome) => {
      if (outcome.status !== 'succeeded') {
        return null
      }
      if (Object.hasOwn(outcome, 'optionResult')) {
        return readNoChoiceOptionResult(outcome.optionResult, params)
      }
      return {
        key: params.key,
        value: params.value,
        ...(ctx.persistedOptions ? { options: { ...ctx.persistedOptions } } : {})
      }
    }
  } satisfies MutationPlan<AgentSessionOptionResult>
}
