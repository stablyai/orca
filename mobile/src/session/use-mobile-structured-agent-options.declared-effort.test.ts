import { expect, it, vi } from 'vitest'
import type { AcpDeclaredEffortFixtureModule } from '../../../src/shared/acp-declared-effort.test-fixture-contract'
import {
  BASE,
  descriptorFor,
  mountOptions,
  optionsClient
} from './use-mobile-structured-agent-options.test-fixture'

const { recordedEffortCase } = await vi.importActual<AcpDeclaredEffortFixtureModule>(
  '../../../src/main/acp/acp-declared-effort.test-fixture'
)

it('renders trustworthy context through the phone consumer while capturing only accepted input', async () => {
  for (const input of ['low', 'max', 'opencode', 'absent'] as const) {
    const { agent, model, display, live, resting, catalog } = await recordedEffortCase(input)
    for (const answer of [live, resting]) {
      let response = Promise.resolve(answer)
      const { client } = optionsClient(
        () => response,
        async () => catalog
      )
      const harness = await mountOptions({
        ...BASE,
        sessionId: `declaration-${input}-${answer === live ? 'live' : 'rest'}`,
        agent,
        client,
        mutate: vi.fn(),
        sendSelection: true
      })
      const effort = descriptorFor(harness.current().optionSnapshot, 'effort')
      if (answer.models.find((row) => row.id === model)!.efforts.length > 0) {
        expect(effort?.valueSource).toBe(display ? 'default' : 'unknown')
      } else {
        expect(effort).toBeUndefined()
      }
      expect(effort?.kind.currentValue).toBe(display ?? undefined)
      expect(harness.current().sendSelection()).toEqual({ selection: { model } })
      response = new Promise(() => {})
      await harness.rerender({ fence: 2 })
      expect(descriptorFor(harness.current().optionSnapshot, 'effort')?.kind.currentValue).toBe(
        display ?? undefined
      )
      expect(harness.current().sendSelection()).toEqual({ selection: { model } })
      await harness.unmount()
    }
  }
})
