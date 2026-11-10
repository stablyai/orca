import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { buildRegistry, defineMethod, type RpcContext } from '../../../core'
import { attachMutationReplayNudge } from '../../../orchestration-mutation-receipt'
import { ORCHESTRATION_SEND_METHODS } from '../messaging/send-methods'
import { defineOrchestrationMethod } from './orchestration-method-access'

const refuse = (): never => {
  throw new Error('refused')
}

const ctx: RpcContext = { runtime: new OrcaRuntimeService() }

describe('orchestration method access declarations', () => {
  it('refuses to register an orchestration method without one', () => {
    const undeclared = defineMethod({
      name: 'orchestration.undeclared',
      permission: 'workspace',
      params: null,
      handler: () => null
    })
    expect(() => buildRegistry([undeclared])).toThrow(
      'orchestration_method_without_access:orchestration.undeclared'
    )
  })

  it('refuses a declaration whose rule its handler never runs', () => {
    const bypass = {
      ...defineMethod({
        name: 'orchestration.bypass',
        permission: 'workspace',
        params: null,
        handler: () => 'effect'
      }),
      orchestrationAccess: { kind: 'writes', targets: {}, rule: refuse }
    } as const
    expect(() => buildRegistry([bypass])).toThrow(
      'orchestration_method_without_access:orchestration.bypass'
    )
  })

  it('refuses a checked handler registered without its own declaration', () => {
    const [send] = ORCHESTRATION_SEND_METHODS
    const redeclared = defineMethod({
      name: send.name,
      permission: send.permission,
      params: send.params,
      handler: send.handler
    })
    expect(() => buildRegistry([redeclared])).toThrow(
      'orchestration_method_without_access:orchestration.send'
    )
  })

  it('keeps a refusal a rejected promise for async handlers and a throw for sync ones', async () => {
    const asyncMethod = defineOrchestrationMethod({
      name: 'orchestration.asyncProbe',
      permission: 'workspace',
      params: null,
      access: { kind: 'writes', targets: {}, rule: refuse },
      handler: async () => 'effect'
    })
    const syncMethod = defineOrchestrationMethod({
      name: 'orchestration.syncProbe',
      permission: 'workspace',
      params: null,
      access: { kind: 'writes', targets: {}, rule: refuse },
      handler: () => 'effect'
    })
    let pending: Promise<string> | undefined
    expect(() => {
      pending = asyncMethod.handler(undefined, ctx)
    }).not.toThrow()
    await expect(pending).rejects.toThrow('refused')
    expect(() => syncMethod.handler(undefined, ctx)).toThrow('refused')
  })

  it('replays an accepted call before any rule, so a replay is never authorized again', () => {
    const method = defineOrchestrationMethod({
      name: 'orchestration.replayProbe',
      permission: 'workspace',
      params: null,
      access: { kind: 'writes', targets: {}, rule: refuse },
      replay: (_params, { replayedMutationReceipt }) => ({ receipt: replayedMutationReceipt }),
      handler: () => 'effect'
    })
    expect(method.handler(undefined, { ...ctx, replayedMutationReceipt: 'accepted' })).toBe(
      'accepted'
    )
    expect(() => method.handler(undefined, ctx)).toThrow('refused')
  })

  it("keeps send's replay a promise, rejected when redelivering its nudge fails", async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {
      throw new Error('nudge failed')
    })
    const [send] = ORCHESTRATION_SEND_METHODS
    const receipt = attachMutationReplayNudge(
      { message: { id: 'msg_accepted' } },
      { kind: 'messages', targets: [{ to: 'term_x', type: 'status' }] }
    )
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = send.handler(send.params.parse({ subject: 's', from: 'term_x' }), {
        runtime,
        replayedMutationReceipt: receipt
      })
    }).not.toThrow()
    await expect(pending).rejects.toThrow('nudge failed')
    db.close()
  })
})
