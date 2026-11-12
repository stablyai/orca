import { afterEach, expect, it } from 'vitest'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { selectStructuredAgentSettledTurns } from '../../../shared/agent-session/view/structured-agent-session-turn-timing'

afterEach(closeProviderTimelineRigs)

it('retains provider-token throughput across settlement and reload without counting tool time', async () => {
  const rig = await openProviderTimelineRig({ agent: 'omp' })
  const translator = new AcpTimelineTranslator({
    sessionId: 'omp-session',
    dialect: OMP_ACP_DIALECT
  })
  const first = translator.openPrompt('first', 1_000)
  first.events.forEach((event) => rig.assembler.apply(event))
  translator
    .notification('_orca/omp/generation', { outputTokens: 84, durationMs: 2_000 }, 30_000)
    .forEach((event) => rig.assembler.apply(event))
  translator
    .promptResult('first', { stopReason: 'end_turn' }, 31_000)
    .forEach((event) => rig.assembler.apply(event))
  const before = selectStructuredAgentSettledTurns(await rig.rows())
  expect([...before.values()][0]?.tokensPerSecond).toBe(42)

  const reopened = await rig.reopenJournal()
  const restored = selectStructuredAgentSettledTurns(reopened.snapshot().items)
  expect([...restored.values()][0]?.tokensPerSecond).toBe(42)
})

it('leaves an unmeasured response unavailable rather than timing replayed text', async () => {
  const rig = await openProviderTimelineRig({ agent: 'omp' })
  const translator = new AcpTimelineTranslator({
    sessionId: 'omp-session',
    dialect: OMP_ACP_DIALECT
  })
  translator.beginLoad()
  expect(
    translator.notification('_orca/omp/generation', { outputTokens: 84, durationMs: 2_000 }, 20_000)
  ).toEqual([])
  translator.finishLoad()
  translator.openPrompt('unknown', 21_000).events.forEach((event) => rig.assembler.apply(event))
  translator
    .notification('_orca/omp/generation', { outputTokens: 84, durationMs: 0 }, 22_000)
    .forEach((event) => rig.assembler.apply(event))
  translator
    .promptResult('unknown', { stopReason: 'end_turn' }, 23_000)
    .forEach((event) => rig.assembler.apply(event))
  const settled = selectStructuredAgentSettledTurns(await rig.rows())
  expect([...settled.values()][0]?.tokensPerSecond).toBeUndefined()
})
