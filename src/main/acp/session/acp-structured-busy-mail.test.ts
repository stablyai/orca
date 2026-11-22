import { afterEach, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readTestHostJournal } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { agentSessionMessagePayload } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createRestTestRig,
  restTestSend,
  REST_TEST_CALLER,
  type RestTestRig
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import type { FakeFrame } from '../process/testing/acp-scripted-agent.test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { promptIdOf } from './testing/acp-structured-host.test-support'
import {
  openAcpAdapterRig,
  replyChunk,
  waitFor
} from './testing/acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

// A peer bot's mail in a bot group (#46172) reaches a busy member as queued orchestration mail.
// ACP agents (Antigravity, Grok, ...) can take input mid-turn only by cancelling the running
// prompt, so the mail must wait for the turn to end instead of interrupting it (#45370).
const PEER_MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'peer', dispatchId: null, messages: [] }
}

function mailSend(text: string) {
  const body = { ...hostTestMessage(text), from: PEER_MAIL }
  // Sender identity is excluded from the payload fingerprint.
  const fields = { body: agentSessionMessagePayload(body), delivery: 'queue-if-active' as const }
  return {
    ...fields,
    body,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields
      })
    }
  }
}

async function openBusyAcpChat() {
  const spec = acpLaunchSpecFor('grok')!
  const prompts: FakeFrame[] = []
  let hostRig: RestTestRig | undefined
  const acp = await openAcpAdapterRig({
    spec,
    // Prompts stay open until the test answers them, so the first turn is busy.
    script: (agent) => agent.on('session/prompt', (frame) => prompts.push(frame)),
    deps: {
      onEvent: (event) => hostRig?.host.handleAdapterEvent(event),
      onDispatchSettledLate: (settlement) => void hostRig?.host.settleLateDispatch(settlement),
      now: () => hostRig?.clock.now ?? 0
    }
  })
  const rig = await createRestTestRig({
    adapter: acp.adapter,
    agents: new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(spec), adapter: acp.adapter }
    ])
  })
  hostRig = rig
  rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
  const attached = await rig.host.attach(
    REST_TEST_CALLER,
    hostTestAttachParams(null, {
      provider: 'grok',
      agent: 'grok',
      accountHome: { variable: 'GROK_HOME', path: rig.root },
      providerHandle: undefined
    })
  )
  expect(attached).toMatchObject({ ok: true })
  return { rig, acp, prompts }
}

const promptText = (frame: FakeFrame | undefined) => JSON.stringify(frame?.params ?? null)

it("holds a peer bot's mail while an ACP member answers earlier mail, then delivers it once without cancelling that turn", async () => {
  const { rig, acp, prompts } = await openBusyAcpChat()
  const wake = () => rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
  // The member is mid-answer: its turn is open and streaming.
  const streaming = async (prompt: FakeFrame) => {
    acp.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Working'))
    await acp.settle()
    await rig.host.flushStreamedEvents(SESSION)
  }
  try {
    // The owner's group post is running when Bot a's question arrives, so the question queues.
    expect(await rig.host.send(REST_TEST_CALLER, restTestSend('Answer the group'))).toMatchObject({
      ok: true
    })
    await waitFor(() => expect(prompts).toHaveLength(1))
    await streaming(prompts[0]!)
    expect(
      await rig.host.send(REST_TEST_CALLER, mailSend('peer bot asks a question'))
    ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    const { agent } = acp.child()
    agent.reply(prompts[0]!, { stopReason: 'end_turn' })
    // The queued question starts its own turn: the room line "Bot a asked Bot b".
    await waitFor(() => expect(prompts).toHaveLength(2))
    expect(promptText(prompts[1])).toContain('peer bot asks a question')
    await streaming(prompts[1]!)

    // More mail arrives while Bot b answers. It must wait, not cancel the answer.
    expect(await rig.host.send(REST_TEST_CALLER, mailSend('peer bot follows up'))).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    await wake()
    await acp.settle()
    expect(acp.sent('session/cancel')).toHaveLength(0)
    expect(prompts).toHaveLength(2)

    agent.reply(prompts[1]!, { stopReason: 'end_turn' })
    await waitFor(() => expect(prompts).toHaveLength(3))
    expect(promptText(prompts[2])).toContain('peer bot follows up')
    agent.reply(prompts[2]!, { stopReason: 'end_turn' })
    // Exactly once: let the host commit every turn and settle every send, then drain the queue
    // once more, so a duplicate that this commit made eligible would have gone out by now.
    await waitFor(async () => {
      const journal = await readTestHostJournal(rig.host, SESSION)
      const turns = journal.items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
      expect(turns.map((turn) => turn.state)).toEqual(['completed', 'completed', 'completed'])
      expect(journal.submissions.map((send) => send.dispatchState)).toEqual([
        'accepted',
        'accepted',
        'accepted'
      ])
    })
    await rig.host.drainStatusWrites()
    // The commit observer schedules any claim; the session queue then runs it before we look.
    await rig.host.flushStreamedEvents(SESSION)
    await rig.host.serialize(SESSION, async () => {})
    await wake()
    await acp.settle()
    expect(prompts).toHaveLength(3)
    expect(acp.sent('session/cancel')).toHaveLength(0)
  } finally {
    await acp.adapter.closeAll()
    await closeProviderTimelineRigs()
    await rig.dispose()
  }
})
