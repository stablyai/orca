import { beforeEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_TURN_SENDER_METHODS } from '../rpc/methods/orchestration/turn-sender'
import {
  agentSessionSenderKey,
  drivingDeviceFor,
  recordDrivingDevice,
  resetDrivingDevices,
  terminalSenderKey
} from './driving-device-registry'

type Ctx = Parameters<(typeof ORCHESTRATION_TURN_SENDER_METHODS)[0]['handler']>[1]
const handler = ORCHESTRATION_TURN_SENDER_METHODS[0]!.handler

function ctx(partial: Record<string, unknown>): Ctx {
  const runtime = {
    verifyOrchestrationCompatibilityCaller: (evidence: { terminalHandle?: string; launchToken?: string } | undefined) =>
      evidence?.launchToken === 'right' ? { terminalHandle: evidence.terminalHandle } : null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  return { runtime, ...partial } as unknown as Ctx
}

describe('driving device registry', () => {
  beforeEach(() => resetDrivingDevices())

  it('records only paired devices (people), never the local CLI or local windows', () => {
    recordDrivingDevice(terminalSenderKey('t1'), { kind: 'local-cli' }, 1)
    recordDrivingDevice(terminalSenderKey('t1'), { kind: 'desktop' }, 2)
    expect(drivingDeviceFor(terminalSenderKey('t1'))).toBeNull()
    recordDrivingDevice(terminalSenderKey('t1'), { kind: 'paired-device', deviceId: 'dev-bob' }, 3)
    recordDrivingDevice(terminalSenderKey('t1'), { kind: 'local-cli' }, 4)
    expect(drivingDeviceFor(terminalSenderKey('t1'))).toEqual({ deviceId: 'dev-bob', at: 3 })
  })

  it('answers an agent only about itself, identified by orcad evidence, never a parameter', async () => {
    recordDrivingDevice(terminalSenderKey('t-alice'), { kind: 'paired-device', deviceId: 'dev-alice' }, 1)
    recordDrivingDevice(terminalSenderKey('t-bob'), { kind: 'paired-device', deviceId: 'dev-bob' }, 2)
    recordDrivingDevice(agentSessionSenderKey('s1'), { kind: 'paired-device', deviceId: 'dev-carol' }, 3)
    const asTerminal = (terminalHandle: string, launchToken: string) =>
      handler(undefined, ctx({ caller: { kind: 'local-cli' }, orchestrationCompatibilityEvidence: { terminalHandle, launchToken } }))
    expect(await asTerminal('t-bob', 'right')).toEqual({
      caller: { kind: 'terminal', handle: 't-bob' },
      sender: { deviceId: 'dev-bob', at: 2 }
    })
    // A forged launch token proves nothing.
    expect(await asTerminal('t-alice', 'forged')).toEqual({ caller: null, sender: null })
    expect(await handler(undefined, ctx({ caller: { kind: 'local-cli' }, orchestrationCaller: { sessionId: 's1' } }))).toEqual({
      caller: { kind: 'session', sessionId: 's1' },
      sender: { deviceId: 'dev-carol', at: 3 }
    })
    // Paired clients are people, not agents: they get no answer.
    expect(
      await handler(undefined, ctx({ caller: { kind: 'paired-device', deviceId: 'dev-bob' }, orchestrationCompatibilityEvidence: { terminalHandle: 't-bob', launchToken: 'right' } }))
    ).toEqual({ caller: null, sender: null })
  })
})
