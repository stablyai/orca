import { afterEach, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  sweepOnce,
  type RestTestRig
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { STRUCTURED_AGENT_SESSION_IDLE_MS as IDLE_MS } from '../../native-chat/agent-session-wire/termination/structured-agent-session-idle-sweep'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { readAcpFixture } from '../timeline/testing/acp-timeline-fixture.test-support'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { openAcpAdapterRig, waitFor } from './testing/acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './testing/acp-structured-fixture-replay.test-support'

afterEach(closeProviderTimelineRigs)

async function openChat(agent: 'omp' | 'grok', replay?: GrokFixtureReplay) {
  const spec = acpLaunchSpecFor(agent)!
  let hostRig: RestTestRig | undefined
  const acp = await openAcpAdapterRig({
    spec,
    script: (scripted) => {
      if (replay) {
        replay.attach(scripted)
      } else {
        scripted.on('session/prompt', (frame) => scripted.reply(frame, { stopReason: 'end_turn' }))
      }
    },
    deps: { onEvent: (event) => hostRig?.host.handleAdapterEvent(event) }
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
      provider: agent,
      agent,
      accountHome: {
        variable: agent === 'omp' ? 'PI_CODING_AGENT_DIR' : 'GROK_HOME',
        path: rig.root
      },
      providerHandle: undefined
    })
  )
  expect(attached).toMatchObject({ ok: true })
  return { rig, acp }
}

async function sendAndFinish(rig: RestTestRig, text: string, completed: number) {
  expect(await rig.host.send(REST_TEST_CALLER, restTestSend(text))).toMatchObject({ ok: true })
  await waitFor(async () => {
    const turns = (await rig.host.journalSnapshot(SESSION)).items.flatMap(
      (item) => readAgentJournalTurn(item.body) ?? []
    )
    expect(turns).toHaveLength(completed)
    expect(turns.every((turn) => turn.state === 'completed')).toBe(true)
  })
}

it('retains an aged OMP child after recorded parent completion, accepts another send, and closes explicitly', async () => {
  const replay = new GrokFixtureReplay(await readAcpFixture('omp-v17-reply-without-thought'))
  const { rig, acp } = await openChat('omp', replay)
  try {
    await sendAndFinish(rig, 'First question', 1)
    const child = acp.child()
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(child.exited).toBe(false)
    expect(rig.host.hasSession(SESSION)).toBe(true)

    // Completion uncertainty remains uncertainty even long after the normal idle window.
    rig.clock.now += 24 * 60 * 60_000
    await sweepOnce(rig.host)
    expect(child.exited).toBe(false)
    await sendAndFinish(rig, 'Follow-up question', 2)
    expect(replay.awaiting).toBeNull()
    expect(acp.child()).toBe(child)

    await rig.host.close(SESSION, 'user-close')
    expect(child.exited).toBe(true)
    expect(rig.host.hasSession(SESSION)).toBe(false)
  } finally {
    await acp.adapter.closeAll()
    await rig.dispose()
  }
})

it('still retires an idle ACP child whose provider has no extra idle confirmation', async () => {
  const { rig, acp } = await openChat('grok')
  try {
    await sendAndFinish(rig, 'First question', 1)
    const child = acp.child()
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(child.exited).toBe(true)
    expect(rig.host.hasSession(SESSION)).toBe(false)
  } finally {
    await acp.adapter.closeAll()
    await rig.dispose()
  }
})
