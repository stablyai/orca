import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { RpcCallerIdentity } from '../../../callers/rpc-caller-identity'
import { workerApprovalAccess } from './worker-approval-access'

const PERSON_CLIENT = ['orchestration.person-approvals.v1']

const allow = (
  caller: RpcCallerIdentity,
  clientCapabilities: readonly string[] = PERSON_CLIENT,
  orchestrationCaller?: RpcContext['orchestrationCaller']
) =>
  workerApprovalAccess({
    params: { dispatch: 'ctx_1', prompt: 'apr_1', decision: 'allow' },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only these fields.
    ctx: {
      caller,
      clientCapabilities,
      orchestrationCaller,
      runtime: { coordinatorApprovalsEnabled: () => false }
    } as unknown as RpcContext,
    caller: undefined
  })

describe('worker approval access', () => {
  it('lets a person on a paired window or phone allow a worker prompt', () => {
    expect(allow({ kind: 'paired-device', deviceId: 'phone-1' })).toEqual({
      answeredBy: 'person',
      reason: null
    })
  })

  it("refuses an agent's allow that arrives over a pairing", () => {
    expect(() => allow({ kind: 'paired-device', deviceId: 'laptop-1', agent: true })).toThrow(
      /Only a person can allow apr_1/
    )
    // An orca CLI from before the agent flag declares nothing.
    expect(() => allow({ kind: 'paired-device', deviceId: 'laptop-1' }, [])).toThrow(
      /Only a person can allow apr_1/
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `kind` is read.
    const peer = { kind: 'peer' } as unknown as RpcContext['orchestrationCaller']
    expect(() =>
      allow({ kind: 'paired-device', deviceId: 'laptop-1' }, PERSON_CLIENT, peer)
    ).toThrow(/Only a person can allow apr_1/)
  })
})
