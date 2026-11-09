import { afterEach, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { FakeFrame } from '../process/testing/acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

const HELLO: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

function send(
  rig: AcpAdapterRig,
  clientMessageId: string,
  executionOptions: { model?: string; effort?: string },
  signal?: AbortSignal
) {
  return rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId,
    body: HELLO,
    fence: 1,
    executionOptions,
    ...(signal ? { signal } : {})
  })
}

/** Holds the first model/effort write unanswered; answers every later one. */
async function openWithHeldFirstWrite(
  optionWriteTimeoutMs: number
): Promise<{ rig: AcpAdapterRig; held: () => FakeFrame }> {
  let held: FakeFrame | undefined
  const rig = await openAcpAdapterRig({
    deps: { optionWriteTimeoutMs },
    script: (agent) => {
      agent.on('session/set_config_option', (frame) => {
        if (!held) {
          held = frame
          return
        }
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      })
    }
  })
  await rig.acquire()
  return {
    rig,
    held: () => {
      if (!held) {
        throw new Error('no option write held yet')
      }
      return held
    }
  }
}

it('refuses only the message whose model write went unanswered, keeping the agent running', async () => {
  const { rig, held } = await openWithHeldFirstWrite(100)

  await expect(send(rig, 'send-1', { model: 'grok-4.6' })).rejects.toThrow()

  // The unanswered call is withdrawn at the agent, and the agent process is never ended for it.
  const cancel = await rig.frame('$/cancel_request')
  expect(cancel.params).toEqual({ requestId: held().id })
  await rig.settle()
  expect(rig.ended).toEqual([])
  expect(rig.child().closes).toBe(0)
  expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)

  await expect(send(rig, 'send-2', { model: 'grok-4.6' })).resolves.toEqual({ state: 'admitted' })
  expect(rig.sent('session/set_config_option')).toHaveLength(2)
  await rig.frame('session/prompt')
})

it('holds later controls and prompts until a withdrawn write is answered', async () => {
  // Long enough that no deadline expires; the held write settles only when answered below.
  const { rig, held } = await openWithHeldFirstWrite(10_000)
  const withdrawn = new AbortController()
  const first = send(rig, 'send-1', { effort: 'low' }, withdrawn.signal)
  await waitFor(() => held())
  withdrawn.abort(new Error('replaced by a newer message'))
  await expect(first).rejects.toThrow('replaced by a newer message')

  const second = send(rig, 'send-2', { model: 'grok-4.6' })
  await rig.settle()
  // The withdrawn effort write may still land, so nothing follows it to the agent yet.
  expect(rig.sent('session/set_config_option')).toHaveLength(1)
  expect(rig.sent('session/prompt')).toEqual([])

  rig.child().agent.reply(held(), { configOptions: GROK_CONFIG_OPTIONS })
  await expect(second).resolves.toEqual({ state: 'admitted' })
  expect(rig.sent('session/set_config_option')).toHaveLength(2)
  await rig.frame('session/prompt')
  expect(rig.ended).toEqual([])
})

it.each([
  {
    end: 'the agent exits on its own',
    trigger: (rig: AcpAdapterRig) => rig.child().exit(),
    closedByOrca: undefined,
    reason: /^grok ACP agent exited/
  },
  {
    end: 'Orca loses its connection to the agent',
    trigger: (rig: AcpAdapterRig) => rig.child().agent.stdin.destroy(),
    closedByOrca: true,
    reason: /^grok ACP connection closed/
  }
])(
  'keeps who ended the agent when its final journal write is refused: $end',
  async ({ trigger, closedByOrca, reason }) => {
    const rig = await openAcpAdapterRig()
    let refusing = false
    const events = rig.rig.eventSink
    const append = events.tryAppendTransition?.bind(events)
    rig.rig.eventSink = {
      ...events,
      tryAppendTransition: (transition) =>
        refusing ? { accepted: false, reason: 'failed' } : append!(transition)
    }
    await rig.acquire()
    refusing = true
    trigger(rig)
    const [ended] = await waitFor(() => {
      expect(rig.ended).toHaveLength(1)
      return rig.ended
    })
    expect(ended?.closedByOrca).toBe(closedByOrca)
    expect(ended?.reason).toMatch(reason)
  }
)
