import { describe, expect, it, vi } from 'vitest'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { withAcpModelFallback } from './acp-model-command'
import { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredSession } from './acp-structured-session'
import type { SessionConfigOption } from './generated/acp-protocol.generated'

const config = (model: string, thinking: string): SessionConfigOption[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'p/a', name: 'A' },
      { value: 'p/b', name: 'B' }
    ]
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: thinking,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ]
  }
]

// No turn runs and nothing stops, so the command never waits or withdraws.
const idleTurns = {
  running: false,
  withdrawalEpoch: 0,
  withdrawnSince: () => null,
  holdSteer: () => () => undefined
}

describe("OMP's own model command", () => {
  it.each(['aborted', 'timed out'] as const)(
    'leaves the role unapplied and retires OMP when the command is %s',
    async (ending) => {
      const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
      options.adoptSession({ configOptions: config('p/a', 'low') }, 'loaded')
      const late = Promise.withResolvers<void>()
      const retired = vi.fn()
      const aborted = new AbortController()
      // A genuine late success: OMP's reply, its config push and a normal end, after Orca gave up.
      const prompt = async () => {
        await late.promise
        options.commandReply += 'Model set to p/b.'
        options.adoptConfigOptions(config('p/b', 'low'))
        return { stopReason: 'end_turn' }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the command reads only spec, options, the idle turns and connection.prompt, which this fake provides.
      const session = {
        spec: acpLaunchSpecFor('omp')!,
        options,
        turns: idleTurns,
        connection: { prompt }
      } as unknown as AcpStructuredSession
      const bound = {
        agent: 'omp',
        timeoutMs: ending === 'timed out' ? 1 : 1_000,
        signal: aborted.signal,
        onUncertain: retired
      }
      const pending = withAcpModelFallback(session, bound, (fallback) =>
        fallback.command!('@worker_be')
      )
      if (ending === 'aborted') {
        aborted.abort()
      }
      await expect(pending).rejects.toThrow()
      expect(retired).toHaveBeenCalledOnce()
      // A late success cannot restore proof the abort retired.
      late.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(options.appliedInput.has('model')).toBe(false)
      expect(options.writing).toBe(0)
    }
  )
})
