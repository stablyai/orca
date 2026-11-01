import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  sendHello,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'

const opened: AcpAdapterRig[] = []

afterEach(async () => {
  for (const rig of opened.splice(0)) {
    await rig.adapter.forceCloseSession(SESSION)
  }
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

describe('OMP prompts rejected while the provider is busy', () => {
  it('keeps the send alive through repeated busy responses and completes it once', async () => {
    const spec = acpLaunchSpecFor('omp')
    if (!spec) {
      throw new Error('OMP launch spec missing')
    }
    let attempts = 0
    const rig = await openAcpAdapterRig({
      spec,
      script: (agent) =>
        agent.on('session/prompt', (frame) => {
          attempts += 1
          if (attempts <= 3) {
            agent.fail(frame, -32003, 'Agent is already processing.', { reason: 'session_busy' })
          } else {
            agent.reply(frame, { stopReason: 'end_turn' })
          }
        })
    })
    opened.push(rig)
    await rig.acquire()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await sendHello(rig, 'held-send')
    await rig.settle()
    await vi.advanceTimersByTimeAsync(40_000)
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(4)
    expect(rig.sent('session/prompt').map((frame) => frame.params)).toEqual(
      Array.from({ length: 4 }, () => ({
        sessionId: 'acp-session-1',
        prompt: [{ type: 'text', text: 'hello' }]
      }))
    )
    const rows = await rig.rig.rows()
    expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toMatchObject([
      { state: 'completed', outcome: 'success' }
    ])
    expect(rig.settled).toEqual([
      expect.objectContaining({
        clientMessageId: 'held-send',
        providerIdentity: { provider: 'orca', clientMessageId: 'held-send' }
      })
    ])
  })
})
