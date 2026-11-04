import { act } from 'react-test-renderer'
import { expect, it } from 'vitest'
import {
  BASE,
  accepted,
  descriptorFor,
  mountOptions,
  optionsClient,
  recordingMutate
} from './use-mobile-structured-agent-options.test-fixture'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'

it.each([true, false])(
  'requests the selected model menu only from a capable phone host (%s)',
  async (capable) => {
    const A = 'opencode/crouton-alpha-free'
    const B = 'opencode/beam-free'
    const models = [
      { id: A, label: A, isDefault: false, efforts: [{ value: 'high', label: 'High' }] },
      { id: B, label: B, isDefault: false, effortsKnown: false as const, efforts: [] }
    ]
    const live: AgentSessionOptionsResult = { models, current: { model: A, effort: 'high' } }
    const { client, methods } = optionsClient(
      async () => live,
      async () => ({ origin: 'probe', fetchedAt: 1, models })
    )
    const { mutate } = recordingMutate(async (_call, fields) =>
      accepted(
        {
          key: 'model',
          value: String(fields.value),
          options: { model: String(fields.value), effort: 'high' }
        },
        true
      )
    )
    const harness = await mountOptions({
      ...BASE,
      sessionId: `phone-opencode-${capable}`,
      agent: 'opencode2',
      client,
      mutate,
      modelEffortDiscovery: capable
    })
    await act(async () => {
      await harness.current().setStructuredOption('model', B)
    })
    const requests = methods('agentSession.modelCatalog').map((row) => row.params)
    if (capable) {
      expect(requests).toContainEqual({
        agent: 'opencode2',
        sessionId: `phone-opencode-${capable}`,
        selectedModel: B
      })
    } else {
      expect(
        requests.every(
          (row) => typeof row === 'object' && row !== null && !Object.hasOwn(row, 'selectedModel')
        )
      ).toBe(true)
    }
    expect(descriptorFor(harness.current().optionSnapshot, 'model')?.settable).toBe(true)
    await harness.unmount()
  }
)
