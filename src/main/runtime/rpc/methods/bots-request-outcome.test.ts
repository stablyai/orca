import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import type { RpcCallerIdentity } from '../callers/rpc-caller-identity'
import type { RpcCallerScope } from '../callers/rpc-caller-scope'
import { BOT_REQUEST_OUTCOME_METHOD } from './bots-request-outcome'

// A handoff the receiving bot has answered, as the host's orchestration record holds it.
const db = {
  getBotRequest: () => ({}),
  getMessageById: () => ({
    id: 'msg_1',
    thread_id: null,
    from_handle: 'orca://session/sender',
    to_handle: 'orca://session/receiver'
  }),
  getThreadMessagesFor: () => [
    { id: 'msg_2', body: 'Done.', payload: JSON.stringify({ botAnswer: true, requestId: 'msg_1' }) }
  ],
  getBotRequestOutcome: () => 'answered'
}

function readAs(caller: RpcCallerIdentity, callerScope?: RpcCallerScope) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these context fields.
  const context = {
    runtime: { getOrchestrationDb: () => db },
    caller,
    callerScope,
    pairedDeviceId: caller.kind === 'paired-device' ? caller.deviceId : undefined
  } as unknown as RpcContext
  return BOT_REQUEST_OUTCOME_METHOD.handler({ messageId: 'msg_1' }, context)
}

describe('bots.request.outcome', () => {
  it("reads the answered request in a person's Orca, a paired desktop's or phone's, and the host CLI", () => {
    const desktop = readAs(
      { kind: 'paired-device', deviceId: 'desktop_b' },
      {
        kind: 'runtime-paired',
        grants: []
      }
    )
    expect(desktop).toMatchObject({ outcome: 'answered', answer: 'Done.', mailIds: ['msg_2'] })
    expect(readAs({ kind: 'paired-device', deviceId: 'phone' }, { kind: 'mobile' })).toEqual(
      desktop
    )
    expect(readAs({ kind: 'desktop' })).toEqual(desktop)
    expect(readAs({ kind: 'local-cli' })).toEqual(desktop)
  })

  it('refuses an agent over a paired device', () => {
    expect(() => readAs({ kind: 'paired-device', deviceId: 'desktop_b', agent: true })).toThrow()
  })
})
