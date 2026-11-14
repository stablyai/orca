import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const ask: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Fixture prompt' }]
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

describe('OpenCode 2 recordings through the adapter', () => {
  it("a subagent's own Stop before it starts running stays available, and works once it runs", async () => {
    const child = {
      rootSessionId: PROVIDER_SESSION,
      childSessionId: 'child-1',
      parentSessionId: PROVIDER_SESSION,
      depth: 1
    }
    let notify: (status: string, id?: string) => void = () => {}
    let closeLate = false
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
      script: (agent) => {
        notify = (status, id = 'child-1') =>
          agent.notify('opencode/session/child_update', {
            ...child,
            childSessionId: id,
            type: 'status',
            status
          })
        agent.on('session/prompt', (frame) => {
          notify('created')
          agent.reply(frame, { stopReason: 'end_turn' })
        })
        agent.on('session/close', (frame) => {
          if (closeLate) {
            notify('running', 'child-2')
            notify('interrupted', 'child-2')
            agent.fail(frame, -32603, 'session already closed')
            return
          }
          agent.reply(frame, {})
        })
      }
    })
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask,
      fence: 1
    })
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    const stop = () =>
      rig.adapter.stopBackgroundTasks!({ sessionId: SESSION, fence: 1, taskIds: ['child-1'] })
    await expect(stop()).resolves.toEqual({ cancelled: false, stillRunning: true })
    notify('running')
    await waitFor(() => expect(stop()).resolves.toEqual({ cancelled: true }))
    // A child that reports itself interrupted while the close is out was stopped, even if the close fails.
    notify('created', 'child-2')
    closeLate = true
    await waitFor(() =>
      expect(
        rig.adapter.stopBackgroundTasks!({ sessionId: SESSION, fence: 1, taskIds: ['child-2'] })
      ).resolves.toEqual({ cancelled: true })
    )
  })
})
