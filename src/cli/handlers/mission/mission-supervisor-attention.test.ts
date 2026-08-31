import { describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../../dispatch'
import type { RuntimeClient } from '../../runtime-client'
import { MISSION_HANDLERS } from '../mission'
import { executeMissionRun } from './mission-supervisor'

type TaskState = {
  id: string
  status: 'ready' | 'dispatched' | 'completed'
}

function response<T>(result: T) {
  return { id: 'test', ok: true as const, result, _meta: { runtimeId: 'runtime-test' } }
}

describe('mission supervisor attention', () => {
  it('reports an escalation once, acknowledges it after reporting, and continues waiting for the worker', async () => {
    const task: TaskState = { id: 'task_attention', status: 'ready' }
    const events: string[] = []
    let waitCount = 0
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_attention', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        task.status = 'dispatched'
        return response({ taskId: task.id, dispatchId: 'dispatch_attention', state: 'ready' })
      }
      if (method === 'orchestration.check' && params?.wait) {
        waitCount += 1
        if (waitCount === 1) {
          return response({
            deliveryId: 'delivery_attention',
            messages: [
              {
                id: 'message_escalation',
                type: 'escalation',
                subject: 'Worker needs input',
                body: 'Choose the migration path.'
              }
            ],
            timedOut: false,
            cancelled: false,
            connectionLost: false
          })
        }
        task.status = 'completed'
        return response({
          deliveryId: 'delivery_done',
          messages: [{ id: 'message_done', type: 'worker_done', subject: 'Done', body: '' }],
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      if (method === 'orchestration.check' && params?.ack) {
        events.push(`ack:${String(params.ack)}`)
        return response({ deliveryId: null, messages: [], timedOut: false, cancelled: false })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const onAttention = vi.fn(async ({ deliveryId }: { deliveryId: string }) => {
      events.push(`attention:${deliveryId}`)
    })

    await expect(
      executeMissionRun({
        client: { call, isRemote: false } as unknown as RuntimeClient,
        mission: 'surface escalation',
        runId: 'run_attention',
        from: 'term_coord',
        worktree: 'id:repo::worktree',
        agent: 'codex',
        tasks: [{ key: 'attention', spec: 'Wait for feedback.', deps: [] }],
        maxConcurrency: 1,
        onAttention
      })
    ).resolves.toMatchObject({ state: 'completed', completedTasks: 1 })

    expect(onAttention).toHaveBeenCalledOnce()
    expect(events).toEqual([
      'attention:delivery_attention',
      'ack:delivery_attention',
      'ack:delivery_done'
    ])
    expect(call).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ wait: true, types: 'worker_done,escalation,question' })
    )
    expect(
      call.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    ).toHaveLength(1)
    expect(waitCount).toBe(2)
  })

  it('does not acknowledge attention when its reporter fails', async () => {
    const task: TaskState = { id: 'task_failure', status: 'ready' }
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_failure', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        task.status = 'dispatched'
        return response({ taskId: task.id, dispatchId: 'dispatch_failure', state: 'ready' })
      }
      if (method === 'orchestration.check' && params?.wait) {
        return response({
          deliveryId: 'delivery_failure',
          messages: [
            { id: 'message_failure', type: 'question', subject: 'Need answer', body: 'Proceed?' }
          ],
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      if (method === 'orchestration.check' && params?.ack) {
        throw new Error('attention must not be acknowledged')
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const reportingFailure = new Error('stderr unavailable')

    await expect(
      executeMissionRun({
        client: { call, isRemote: false } as unknown as RuntimeClient,
        mission: 'preserve unread attention',
        runId: 'run_failure',
        from: 'term_coord',
        worktree: 'id:repo::worktree',
        agent: 'codex',
        tasks: [{ key: 'failure', spec: 'Wait for feedback.', deps: [] }],
        maxConcurrency: 1,
        onAttention: async () => {
          throw reportingFailure
        }
      })
    ).rejects.toBe(reportingFailure)

    expect(call).not.toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ ack: 'delivery_failure' })
    )
  })

  it('reports attention to stderr without adding it to JSON stdout', async () => {
    const task: TaskState = { id: 'task_handler', status: 'ready' }
    let waitCount = 0
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'mission.plan') {
        return response({
          mission: 'show attention',
          agent: 'codex',
          plan: { mode: 'single-agent' }
        })
      }
      if (method === 'orchestration.runCreate') {
        return response({ run: { id: 'run_handler', objective: 'show attention' } })
      }
      if (method === 'orchestration.taskCreate') {
        return response({ task: { id: task.id, status: task.status } })
      }
      if (method === 'orchestration.taskList') {
        return response({ runId: 'run_handler', tasks: [task], count: 1 })
      }
      if (method === 'orchestration.workerStart') {
        task.status = 'dispatched'
        return response({ taskId: task.id, dispatchId: 'dispatch_handler', state: 'ready' })
      }
      if (method === 'orchestration.check' && params?.wait) {
        waitCount += 1
        if (waitCount === 1) {
          return response({
            deliveryId: 'delivery_handler_attention',
            messages: [
              {
                id: 'message_handler_attention',
                type: 'question',
                subject: 'Choose \u001b[31ma migration',
                body: 'Should the old schema stay available?\nNext step?',
                payload: '{"dispatchId":"dispatch_handler"}'
              }
            ],
            timedOut: false,
            cancelled: false,
            connectionLost: false
          })
        }
        task.status = 'completed'
        return response({
          deliveryId: 'delivery_handler_done',
          messages: [
            { id: 'message_handler_done', type: 'worker_done', subject: 'Done', body: '' }
          ],
          timedOut: false,
          cancelled: false,
          connectionLost: false
        })
      }
      if (method === 'orchestration.check' && params?.ack) {
        return response({ deliveryId: null, messages: [], timedOut: false, cancelled: false })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const context: HandlerContext = {
      client: { call, isRemote: false } as unknown as RuntimeClient,
      flags: new Map([
        ['text', 'show attention'],
        ['worktree', 'id:repo::worktree'],
        ['from', 'term_coord']
      ]),
      cwd: '/repo',
      json: true
    }

    try {
      await MISSION_HANDLERS['mission start'](context)

      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'Reply: orca orchestration reply --id message_handler_attention --run run_handler --from term_coord'
        )
      )
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('delivery: delivery_handler_attention')
      )
      const attentionOutput = String(stderr.mock.calls[0]?.[0])
      expect(attentionOutput).toContain('Subject: "Choose \\u001b[31ma migration"')
      expect(attentionOutput).toContain(
        'Body: "Should the old schema stay available?\\nNext step?"'
      )
      expect(attentionOutput).toContain('Payload: "{\\"dispatchId\\":\\"dispatch_handler\\"}"')
      expect(attentionOutput).not.toContain('\u001b')
      expect(stdout).toHaveBeenCalledTimes(1)
      expect(String(stdout.mock.calls[0]?.[0])).not.toContain('message_handler_attention')
    } finally {
      vi.restoreAllMocks()
    }
  })
})
