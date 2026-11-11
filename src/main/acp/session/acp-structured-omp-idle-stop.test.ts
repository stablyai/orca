import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

// Shaped like OMP 18.18.2's ACP mapping of a `task` call that spawned a background agent.
const spawned = [
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-task',
    title: 'task',
    kind: 'other',
    status: 'pending',
    rawInput: { tasks: [{ name: 'AuthMap', task: 'Map the auth surface' }] }
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-task',
    status: 'completed',
    rawOutput: {
      content: [{ type: 'text', text: 'Spawned agent `AuthMap`.' }],
      details: { async: { state: 'running', jobId: 'AuthMap', type: 'task' } }
    }
  }
]
const settled = [
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-task',
    status: 'completed',
    rawOutput: {
      content: [{ type: 'text', text: 'AuthMap finished.' }],
      details: { async: { state: 'completed', jobId: 'AuthMap', type: 'task' } }
    }
  }
]

async function ompChat(prompts: readonly (readonly unknown[])[]) {
  const clock = { now: 5_000 }
  let answered = 0
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('omp')!,
    deps: { now: () => clock.now },
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        for (const update of prompts[answered] ?? []) {
          agent.notify('session/update', { sessionId: PROVIDER_SESSION, update })
        }
        answered += 1
        agent.reply(frame, { stopReason: 'end_turn' })
      })
  })
  await rig.acquire()
  const send = async (text: string) => {
    const sent = answered + 1
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: `send-${sent}`,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      fence: 1
    })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.filter((turn) => turn.state === 'completed')).toHaveLength(sent)
    })
  }
  return { rig, clock, send }
}

describe('an OMP chat at idle-stop time', () => {
  it('stays up while its background task runs and stops once OMP reports it settled', async () => {
    const { rig, send } = await ompChat([spawned, settled])
    await send('Map the auth surface in the background')
    await expect(rig.adapter.confirmIdle(SESSION)).resolves.toBe('busy')

    await send('Is AuthMap done?')
    await expect(rig.adapter.confirmIdle(SESSION)).resolves.toBe('idle')
  })

  it('stops a day later when the task ended between prompts, where OMP reports nothing', async () => {
    const { rig, clock, send } = await ompChat([spawned])
    await send('Map the auth surface in the background')
    await expect(rig.adapter.confirmIdle(SESSION)).resolves.toBe('busy')

    clock.now += 24 * 60 * 60_000
    await expect(rig.adapter.confirmIdle(SESSION)).resolves.toBe('idle')
  })
})
