import { expect, it } from 'vitest'
import { readTestHostJournal } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  type RestTestRig
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import {
  GROK,
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  waitFor
} from './testing/acp-structured-adapter.test-support'
import { launch } from './testing/acp-structured-host.test-support'

it('ends an exhausted restore flight without multiplying retries and allows a new same-chat send', async () => {
  let rig: RestTestRig | undefined
  let restoring = false
  let recovered = false
  const requests: string[] = []
  const acp = await openAcpAdapterRig({
    deps: {
      resolveLaunch: launch(() => restoring),
      onEvent: (event) => rig?.host.handleAdapterEvent(event),
      onDispatchSettledLate: (settlement) => void rig?.host.settleLateDispatch(settlement)
    },
    script: (agent) => {
      agent.on('session/new', (frame) => {
        requests.push('session/new')
        agent.reply(frame, { sessionId: 'acp-session-1', configOptions: GROK_CONFIG_OPTIONS })
      })
      agent.on('session/load', (frame) => {
        requests.push('session/load')
        if (recovered) {
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        } else {
          agent.fail(frame, -32603, 'Internal service failure', {
            errorName: 'ServiceUnavailableError'
          })
        }
      })
      agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    }
  })
  rig = await createRestTestRig({
    adapter: acp.adapter,
    agents: new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(GROK), adapter: acp.adapter }
    ])
  })
  rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
  try {
    const attached = await rig.host.attach(
      REST_TEST_CALLER,
      hostTestAttachParams(null, {
        provider: 'grok',
        agent: 'grok',
        accountHome: { variable: 'GROK_HOME', path: rig.root },
        providerHandle: undefined
      })
    )
    expect(attached.ok).toBe(true)
    await waitFor(() => expect(rig!.store.getRecord(SESSION)?.providerHandleChain).toHaveLength(1))
    await rig.host.close(SESSION, 'evict')
    restoring = true
    const failed = await rig.host.send(
      REST_TEST_CALLER,
      restTestSend('during outage', rig.store.getRecord(SESSION)!.lease.runtimeFence)
    )
    expect(failed.ok).toBe(true)
    await waitFor(async () => {
      const snapshot = await readTestHostJournal(rig!.host, SESSION)
      expect(snapshot.submissions[0]?.dispatchState).toBe('rejected')
    })
    expect(requests).toEqual(['session/new', 'session/load', 'session/load', 'session/load'])
    expect(acp.spawned.filter((step) => step === 'spawn')).toHaveLength(2)
    expect(rig.store.getRecord(SESSION)?.providerHandleChain).toHaveLength(1)

    recovered = true
    const retry = await rig.host.send(
      REST_TEST_CALLER,
      restTestSend('after recovery', rig.store.getRecord(SESSION)!.lease.runtimeFence)
    )
    expect(retry.ok).toBe(true)
    await acp.frame('session/prompt')
    expect(requests).toEqual([
      'session/new',
      'session/load',
      'session/load',
      'session/load',
      'session/load'
    ])
    expect((await rig.host.readOptions(SESSION)).models.map((model) => model.id)).toEqual([
      'grok-4.7',
      'grok-4.6'
    ])
    expect(rig.store.getRecord(SESSION)?.providerHandleChain).toHaveLength(2)
    expect(
      rig.store.getRecord(SESSION)?.providerHandleChain.map((link) => link.handle.nativeId)
    ).toEqual(['acp-session-1', 'acp-session-1'])
  } finally {
    await acp.adapter.closeAll()
    await closeProviderTimelineRigs()
    await rig.dispose()
  }
})
