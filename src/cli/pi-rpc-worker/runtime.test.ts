import { describe, expect, it, vi } from 'vitest'
import {
  PiWorkerRuntime,
  buildAskCall,
  buildEscalationCall,
  buildHeartbeatCall,
  buildProgressCall,
  buildWorkerDoneCall
} from './runtime'
import type { PiRpcWorkerDispatchEnvelope, RuntimeClientLike } from './types'

const envelope: PiRpcWorkerDispatchEnvelope = {
  protocol: 'orca.pi.rpc-worker.dispatch',
  version: 1,
  taskId: 'task_exact',
  dispatchId: 'ctx_exact',
  workerHandle: 'term_exact',
  capability: 'cap_exact',
  taskSpec: 'Do work',
  cliCommand: 'orca'
}

function expectBound(call: ReturnType<typeof buildHeartbeatCall>): void {
  expect(call.options.orchestrationCapability).toBe('cap_exact')
  expect(call.params.from).toBe('term_exact')
  expect(call.params.senderPaneKey).toBe(process.env.ORCA_PANE_KEY)
  if (typeof call.params.payload === 'string') {
    expect(JSON.parse(call.params.payload)).toMatchObject({
      taskId: 'task_exact',
      dispatchId: 'ctx_exact'
    })
  }
}

describe('Pi worker runtime call binding', () => {
  it('binds heartbeat, progress, escalation, and done to the launch envelope', () => {
    const calls = [
      buildHeartbeatCall(envelope),
      buildProgressCall(envelope, {
        phase: 'reviewing',
        message: 'Focused cap_exact tests pass'
      }),
      buildEscalationCall(envelope, { subject: 'Blocked', body: 'Need a decision' }),
      buildWorkerDoneCall(envelope, {
        outcome: 'succeeded',
        subject: 'Done',
        body: 'Work done. Tests pass. Nothing remains.',
        filesModified: ['src/a.ts']
      })
    ]
    for (const call of calls) {
      expectBound(call)
    }
    expect(calls[1].params.body).toBe('Focused [redacted] tests pass')
    expect(calls.at(-1)?.params.waitForLifecycleSettlement).toBe(true)
    expect(JSON.parse(calls.at(-1)?.params.payload as string)).toMatchObject({
      outcome: 'succeeded',
      filesModified: ['src/a.ts']
    })
  })

  it('builds bounded ask and resume calls without putting authority in params', () => {
    const initial = buildAskCall(envelope, { question: 'Choose?', options: ['A', 'B'] }, 5_000)
    expect(initial.params).toMatchObject({
      from: 'term_exact',
      question: 'Choose?',
      options: 'A,B',
      timeoutMs: 5_000
    })
    expect(initial.params).not.toHaveProperty('capability')
    expect(initial.options.orchestrationCapability).toBe('cap_exact')

    const resumed = buildAskCall(envelope, { question: 'unused' }, 4_000, 'msg_1')
    expect(resumed.params).toEqual({ from: 'term_exact', timeoutMs: 4_000, resume: 'msg_1' })
  })

  it('accepts an answer and validates exact worker_done settlement', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          answer: 'A',
          messageId: 'msg_1',
          timedOut: false,
          cancelled: false
        }
      })
      .mockResolvedValueOnce({
        result: { lifecycle: { action: 'settled', outcome: 'succeeded' } }
      })
    const runtime = new PiWorkerRuntime({ call } as unknown as RuntimeClientLike, envelope)
    await expect(runtime.ask({ question: 'Choose?' })).resolves.toBe('A')
    await expect(
      runtime.workerDone({
        outcome: 'succeeded',
        subject: 'Done',
        body: 'Work done. Tests pass. Nothing remains.'
      })
    ).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate or mismatched runtime settlement', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        result: { lifecycle: { action: 'settled', outcome: 'failed', duplicate: true } }
      })
    } as unknown as RuntimeClientLike
    const runtime = new PiWorkerRuntime(client, envelope)
    await expect(
      runtime.workerDone({
        outcome: 'succeeded',
        subject: 'Done',
        body: 'Work done. Tests pass. Nothing remains.'
      })
    ).rejects.toThrow('did not accept')
  })
})
