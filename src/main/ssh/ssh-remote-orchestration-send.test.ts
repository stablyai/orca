import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ORCHESTRATION_SENDER_CAPABILITY_ENV } from '../../shared/orchestration-sender-capability'
import {
  getRemoteOrchestrationPayload,
  hasRemoteLifecycleRejection,
  resolveRemoteOrchestrationSender,
  resolveRemoteOrchestrationSenderCapability
} from './ssh-remote-orchestration-send'

describe('remote orchestration send compatibility', () => {
  it('recognizes only structured lifecycle rejections', () => {
    expect(hasRemoteLifecycleRejection({ lifecycle: { action: 'rejected' } })).toBe(true)
    expect(hasRemoteLifecycleRejection({ lifecycle: null })).toBe(false)
    expect(hasRemoteLifecycleRejection({ lifecycle: { action: 'completed' } })).toBe(false)
    expect(hasRemoteLifecycleRejection(null)).toBe(false)
  })

  it('rejects an explicit lifecycle sender that differs from the bound terminal', () => {
    expect(() =>
      resolveRemoteOrchestrationSender(
        new Map([['from', 'term_explicit']]),
        {
          ORCA_TERMINAL_HANDLE: 'term_env',
          [ORCHESTRATION_SENDER_CAPABILITY_ENV]: randomUUID()
        },
        'worker_done'
      )
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }))
  })

  it('uses the bound terminal for lifecycle sends when the explicit claim matches', () => {
    expect(
      resolveRemoteOrchestrationSender(
        new Map([['from', 'term_env']]),
        {
          ORCA_TERMINAL_HANDLE: 'term_env',
          [ORCHESTRATION_SENDER_CAPABILITY_ENV]: randomUUID()
        },
        'worker_done'
      )
    ).toBe('term_env')
  })

  it.each(['worker_done', 'heartbeat'])('fails closed for an identity-less %s', (type) => {
    expect(() => resolveRemoteOrchestrationSender(new Map(), {}, type)).toThrowError(
      expect.objectContaining({ code: 'no_active_sender_terminal' })
    )
  })

  it('fails closed when a lifecycle terminal handle has no capability', () => {
    expect(() =>
      resolveRemoteOrchestrationSender(new Map(), { ORCA_TERMINAL_HANDLE: 'term_env' }, 'heartbeat')
    ).toThrowError(expect.objectContaining({ code: 'no_active_sender_terminal' }))
  })

  it('forwards the runtime-bound capability only for the lifecycle request', () => {
    const senderCapability = randomUUID()
    const resolved = resolveRemoteOrchestrationSenderCapability(
      { [ORCHESTRATION_SENDER_CAPABILITY_ENV]: senderCapability },
      'worker_done'
    )

    expect(resolved === senderCapability).toBe(true)
  })

  it('does not attach the bearer capability to an ordinary message', () => {
    expect(
      resolveRemoteOrchestrationSenderCapability(
        { [ORCHESTRATION_SENDER_CAPABILITY_ENV]: randomUUID() },
        'status'
      )
    ).toBeUndefined()
  })

  it('preserves explicit sender compatibility for non-lifecycle messages', () => {
    expect(
      resolveRemoteOrchestrationSender(
        new Map([['from', 'term_explicit']]),
        { ORCA_TERMINAL_HANDLE: 'term_env' },
        'status'
      )
    ).toBe('term_explicit')
  })

  it('preserves the legacy unknown sender for non-lifecycle messages', () => {
    expect(resolveRemoteOrchestrationSender(new Map(), {}, 'status')).toBe('unknown')
  })

  it('serializes every structured payload field with local CLI semantics', () => {
    const payload = getRemoteOrchestrationPayload(
      new Map([
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['files-modified', 'src/a.ts, src/b.ts,'],
        ['report-path', 'report.md'],
        ['phase', 'reviewing']
      ])
    )

    expect(JSON.parse(payload ?? '{}')).toEqual({
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      filesModified: ['src/a.ts', 'src/b.ts'],
      reportPath: 'report.md',
      phase: 'reviewing'
    })
  })

  it('passes through a raw payload when no structured fields are present', () => {
    expect(getRemoteOrchestrationPayload(new Map([['payload', '{"ok":true}']]))).toBe('{"ok":true}')
  })

  it('rejects mixed raw and structured payloads', () => {
    expect(() =>
      getRemoteOrchestrationPayload(
        new Map([
          ['payload', '{"taskId":"task_1"}'],
          ['task-id', 'task_1']
        ])
      )
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }))
  })
})
