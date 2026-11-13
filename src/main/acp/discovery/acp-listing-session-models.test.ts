import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'
import recorded from '../fixtures/opencode-v2-start-options.json'
import { expect, it, vi, onTestFinished } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  readSessionModels,
  type AcpModelCatalogSessionConnection
} from './acp-listing-session-models'
import { runAgentModelCatalogSession } from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

it.each([6_400, 14_500])(
  'keeps inventory received at %sms when optional model efforts stall',
  async (startupMs) => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const spec = acpLaunchSpecFor('opencode2')!
    const owner = new AbortController()
    const started =
      Promise.withResolvers<Awaited<ReturnType<AcpModelCatalogSessionConnection['start']>>>()
    const late =
      Promise.withResolvers<
        Awaited<ReturnType<AcpModelCatalogSessionConnection['setConfigOption']>>
      >()
    const connection: AcpModelCatalogSessionConnection = {
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { delete: {} } }
      }),
      start: () => started.promise,
      setConfigOption: () => late.promise,
      deleteSession: async () => ({}),
      close: async () => {}
    }
    const run = runAgentModelCatalogSession<
      AcpModelCatalogSessionConnection,
      Awaited<ReturnType<typeof readSessionModels>>
    >(
      () => connection,
      (connection, ready) =>
        readSessionModels(
          spec,
          { kind: 'session', listingNamesConfiguredModel: false },
          connection,
          '/workspace',
          { signal: owner.signal },
          undefined,
          undefined,
          ready
        ),
      { label: 'opencode2', signal: owner.signal }
    )
    await vi.advanceTimersByTimeAsync(startupMs)
    started.resolve({
      kind: 'new',
      sessionId: 'listing',
      response: NewSessionResponseSchema.parse(recorded)
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await run
    expect(result.models.find((row) => row.id === 'opencode/fledge-alpha-free')).toMatchObject({
      label: 'opencode/Fledge Alpha Free',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' },
        { value: 'default', label: 'Default' }
      ]
    })
    expect(result.models.find((row) => row.id === 'opencode/big-pickle')).toMatchObject({
      efforts: [],
      effortsKnown: false
    })
    expect(result.attemptedModels).toEqual(['opencode/big-pickle'])
    late.resolve({ configOptions: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(result.models[1]?.effortsKnown).toBe(false)
  }
)
