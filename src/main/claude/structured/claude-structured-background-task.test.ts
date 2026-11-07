import { describe, expect, it } from 'vitest'
import {
  producer,
  toolUse,
  toolResult,
  system
} from '../claude-child-work-producer-harness.test-fixture'

describe('moving a running Claude call into the background', () => {
  it('targets the invoking call before a task row exists, then retains the background task until its own ending', async () => {
    const run = await producer()
    const connection = run.claude.connections[0]!
    connection.backgroundTasks = async (toolUseId) => {
      expect(toolUseId).toBe('toolu_build')
      run.send(
        system('task_started', {
          task_id: 'shell-31',
          tool_use_id: 'toolu_build',
          task_type: 'local_bash',
          is_backgrounded: true,
          description: 'build distribution'
        })
      )
      run.send(toolResult('toolu_build', 'Running in the background with ID: shell-31'))
      return true
    }
    run.send(toolUse('toolu_build', 'Bash', { command: 'pnpm build' }))
    const target = run.adapter.foregroundTasks('session-1')[0]!
    expect(target).toMatchObject({ toolUseId: 'toolu_build' })
    expect(target.taskId).toBeUndefined()

    expect(await run.adapter.backgroundTask({ ...target, sessionId: 'session-1', fence: 7 })).toBe(
      true
    )
    expect(run.adapter.foregroundTasks('session-1')).toEqual([])
    expect(run.records()).toMatchObject([
      { membership: 'live', residency: 'background', description: 'build distribution' }
    ])
    run.send(
      system('task_notification', {
        task_id: 'shell-31',
        status: 'completed',
        summary: 'Build passed'
      })
    )
    expect(run.records()).toMatchObject([
      { membership: 'settled', outcome: 'succeeded', lastMessage: 'Build passed' }
    ])
    await run.adapter.closeAll()
  })

  it('refuses a completed call, another turn, another acquisition, or another lease without detaching new work', async () => {
    const run = await producer()
    const connection = run.claude.connections[0]!
    connection.backgroundTasks = async () => {
      throw new Error('stale action reached the provider')
    }
    run.send(toolUse('toolu_old', 'Bash', { command: 'pnpm test' }))
    const target = run.adapter.foregroundTasks('session-1')[0]!
    const request = { ...target, sessionId: 'session-1', fence: 7 }
    expect(await run.adapter.backgroundTask({ ...request, turnId: 'old-turn' })).toBe(false)
    expect(await run.adapter.backgroundTask({ ...request, generation: 'old-process' })).toBe(false)
    expect(await run.adapter.backgroundTask({ ...request, fence: 6 })).toBe(false)
    run.send(toolResult('toolu_old', 'Tests passed'))
    run.send(toolUse('toolu_new', 'Bash', { command: 'pnpm build' }))
    expect(await run.adapter.backgroundTask(request)).toBe(false)
    expect(run.adapter.foregroundTasks('session-1')).toMatchObject([{ toolUseId: 'toolu_new' }])
    await run.adapter.closeAll()
  })

  it('offers only root foreground Bash and agent calls, preserving the provider refusal when it has just finished', async () => {
    const run = await producer()
    const connection = run.claude.connections[0]!
    connection.backgroundTasks = async () => false
    run.send(toolUse('toolu_read', 'Read', { file_path: 'package.json' }))
    run.send(toolUse('toolu_background', 'Bash', { command: 'pnpm test', run_in_background: true }))
    run.send(toolUse('toolu_nested', 'Bash', { command: 'pnpm test' }, 'parent-agent'))
    run.send(toolUse('toolu_agent', 'Agent', { prompt: 'Review the changes' }))
    run.send(
      system('task_started', {
        task_id: 'agent-23',
        tool_use_id: 'toolu_agent',
        task_type: 'local_agent',
        description: 'Review'
      })
    )
    const targets = run.adapter.foregroundTasks('session-1')
    expect(targets).toMatchObject([{ toolUseId: 'toolu_agent', taskId: 'agent-23' }])
    expect(targets).toHaveLength(1)
    expect(
      await run.adapter.backgroundTask({ ...targets[0]!, sessionId: 'session-1', fence: 7 })
    ).toBe(false)
    await run.adapter.closeAll()
  })
})
