// Work orcad's readiness never waited on, started once the ready line is out so wake answers sooner.
import { errorMessage } from '../../shared/error-message'
import type { startAgentStateRulesLiveUpdates } from '../runtime/agent-state-rules/agent-state-rules-live-update'
import type { startSpeechModelWarmup } from '../speech/speech-model-warmup'

type OrcadPostReadyDeps = {
  /** First terminal RPCs after a wake list the workspace; warm that path before a client asks. */
  warmTerminalList: () => Promise<unknown>
  /** Agent state rules: cached file, then a network refresh. Clients connect well after it lands. */
  startAgentStateRules: () => Promise<void>
  /** Paired phones dictate through this host; keep its model loaded the same way the desktop does. */
  startSpeechWarmup: () => Promise<void>
}

/** Terminal warm-up goes first: it is what the reconnecting desktop asks for. Never rejects. */
export async function startOrcadPostReadyWork(deps: OrcadPostReadyDeps): Promise<void> {
  const warmup = deps.warmTerminalList().catch((error: unknown) => {
    console.warn(`[orcad] terminal warm-up failed: ${errorMessage(error)}`)
  })
  await Promise.all([
    warmup,
    deps.startAgentStateRules().catch((error: unknown) => {
      console.warn(`[orcad] agent state rules did not start: ${errorMessage(error)}`)
    }),
    deps.startSpeechWarmup().catch((error: unknown) => {
      console.warn(`[speech] Could not start the speech model warm-up: ${errorMessage(error)}`)
    })
  ])
}

type PostReadyStore = Parameters<typeof startAgentStateRulesLiveUpdates>[0] &
  Parameters<typeof startSpeechModelWarmup>[0]

export function orcadPostReadyDeps(
  runtime: { listTerminals(): Promise<unknown> },
  store: PostReadyStore
): OrcadPostReadyDeps {
  return {
    warmTerminalList: async () => runtime.listTerminals(),
    startAgentStateRules: async () => {
      const { startAgentStateRulesLiveUpdates } =
        await import('../runtime/agent-state-rules/agent-state-rules-live-update')
      startAgentStateRulesLiveUpdates(store, (rules) =>
        console.info(`[orcad] agent state rules ${rules.version} (${rules.source})`)
      )
    },
    startSpeechWarmup: async () => {
      const { startSpeechModelWarmup } = await import('../speech/speech-model-warmup')
      startSpeechModelWarmup(store)
    }
  }
}
