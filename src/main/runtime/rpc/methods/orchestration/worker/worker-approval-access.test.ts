import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { RpcCallerIdentity } from '../../../rpc-caller-identity'
import { workerApprovalAccess } from './worker-approval-access'

function answer(
  caller: RpcCallerIdentity | undefined,
  decision: 'allow' | 'deny',
  reason?: string
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only the transport caller.
  const ctx = { caller } as RpcContext
  return workerApprovalAccess({
    params: { dispatch: 'ctx_1', prompt: 'item_1', decision, reason },
    ctx,
    caller: undefined
  })
}

describe('worker approval access', () => {
  it('lets only a person allow, whatever the params say', () => {
    expect(() => answer({ kind: 'local-cli' }, 'allow', 'I am a person')).toThrow(
      expect.objectContaining({ code: 'approval_requires_person' })
    )
    expect(() => answer(undefined, 'allow')).toThrow(
      expect.objectContaining({ code: 'approval_requires_person' })
    )
    expect(answer({ kind: 'desktop' }, 'allow')).toEqual({ answeredBy: 'person', reason: null })
  })

  it('lets an agent deny only with a reason, and a person without one', () => {
    expect(() => answer({ kind: 'local-cli' }, 'deny', '  ')).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
    expect(answer({ kind: 'local-cli' }, 'deny', 'Use a script file.')).toEqual({
      answeredBy: 'coordinator',
      reason: 'Use a script file.'
    })
    expect(answer({ kind: 'paired-device', deviceId: 'phone' }, 'deny')).toEqual({
      answeredBy: 'person',
      reason: null
    })
  })
})
