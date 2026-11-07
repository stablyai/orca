import type { AgentSessionOptionResult } from '../../../shared/agent-session/options/agent-session-options-result'
import type { MutationPlan } from './operations/structured-agent-session-mutation-plans'
import { readNoChoiceOptionResult } from './options/structured-agent-session-option-observation'
import type { TurnOutcome } from './operations/structured-agent-session-turns'

export function setOptionPlan(params: { key: string; value: string | null }) {
  return {
    method: 'agentSession.setOption',
    fields: { key: params.key, value: params.value },
    run: async (ctx): Promise<TurnOutcome<AgentSessionOptionResult>> => {
      const options =
        params.value === null ? {} : { ...ctx.persistedOptions, [params.key]: params.value }
      await ctx.persistOptions(options)
      ctx.publish()
      return { ok: true, value: { ...params, options } }
    },
    // Reapply unsettled picks; only a settled success can be replayed directly.
    replay: (ctx, outcome) => {
      if (outcome.status !== 'succeeded') {
        return null
      }
      if (params.value !== null && Object.hasOwn(outcome, 'optionResult')) {
        return readNoChoiceOptionResult(outcome.optionResult, {
          key: params.key,
          value: params.value
        })
      }
      return {
        ...params,
        ...(params.value === null ? { modelDefault: ctx.defaultModelSelected === true } : {}),
        ...(ctx.persistedOptions ? { options: { ...ctx.persistedOptions } } : {})
      }
    }
  } satisfies MutationPlan<AgentSessionOptionResult>
}
