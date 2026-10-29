import { describe, expect, it } from 'vitest'
import {
  FAILED_NOTIFICATION,
  FAILED_UPDATE,
  FORWARDED_TOOL,
  harness,
  START_BASH
} from './claude-background-task-row-test-support'

describe('claude background task rows', () => {
  it('reports one failed backgrounded command as ONE row carrying the provider sentence', () => {
    const { rows, items, latest, latestTwin } = harness()
    rows.observe(START_BASH)
    rows.observe(FAILED_UPDATE)
    rows.observe(FAILED_NOTIFICATION)

    const identities = new Set(
      items.map((item) =>
        item.identity.provider === 'orca' ? item.identity.clientMessageId : item.identity.provider
      )
    )
    expect([...identities]).toEqual(['claude-background-task:byjnee2no'])
    expect(latest()).toMatchObject({
      type: 'background-task',
      taskId: 'byjnee2no',
      kind: 'command',
      label: 'Wait for the verification verdict',
      state: 'blocked',
      summary: FAILED_NOTIFICATION.summary,
      outputFile: FAILED_NOTIFICATION.output_file
    })
    expect(latestTwin()).toBe(FAILED_NOTIFICATION.summary)
    expect(latestTwin()).not.toContain('task_notification')
  })

  it('lands the captured failure on its row when the announcement carried no tool id', () => {
    const { rows, latestTwin } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bo2vuy8qb',
      task_type: 'local_bash',
      description: 'verify',
      is_backgrounded: true
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bo2vuy8qb',
      status: 'failed',
      output_file: '',
      summary: "Check the verifier's state"
    })
    expect(latestTwin()).toBe("Check the verifier's state")
  })

  it('keeps terminal ownership after a tracked task reports foregrounded', () => {
    const { rows, latest } = harness()
    rows.observe(START_BASH)
    rows.observe({
      type: 'system',
      subtype: 'task_updated',
      task_id: START_BASH.task_id,
      patch: { is_backgrounded: false, status: 'running' }
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: START_BASH.task_id,
      status: 'failed',
      summary: 'foreground transition failed'
    })
    expect(latest()).toMatchObject({ state: 'blocked', summary: 'foreground transition failed' })
  })

  it('revises in place rather than opening a row from a patch', () => {
    const { rows, items, latest } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'never-announced',
      patch: { status: 'running' }
    })
    expect(items).toEqual([])
    rows.observe(START_BASH)
    rows.observe({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'byjnee2no',
      description: 'Running Bash',
      usage: { total_tokens: 1_200 }
    })
    expect(latest()).toMatchObject({ label: 'Wait for the verification verdict', tokens: 1_200 })
  })

  it('takes no row from a terminal patch for an untracked task', () => {
    const { rows, items } = harness()
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'pre-journal',
        patch: { status: 'failed', description: 'Check logs', error: 'boom' }
      })
    ).toBe(true)
    expect(items).toEqual([])
  })

  it('latches a reported outcome against a later live tick', () => {
    const { rows, latest } = harness()
    rows.observe(START_BASH)
    rows.observe(FAILED_NOTIFICATION)
    rows.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'byjnee2no', task_type: 'local_bash', description: 'still listed' }]
    })
    expect(latest()).toMatchObject({ state: 'blocked' })
  })

  it('ignores late revisions after a task has reported its outcome', () => {
    const { rows, items, latest, turnOpens } = harness()
    rows.observe(START_BASH)
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: START_BASH.task_id,
      status: 'failed',
      summary: 'first run failed'
    })
    const writes = items.length
    const opens = turnOpens.length

    rows.observe({
      type: 'system',
      subtype: 'task_progress',
      task_id: START_BASH.task_id,
      usage: { total_tokens: 99 }
    })
    rows.observe({
      type: 'system',
      subtype: 'task_updated',
      task_id: START_BASH.task_id,
      patch: { error: 'late update' }
    })
    rows.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: START_BASH.task_id, task_type: 'local_bash', description: 'late roster' }]
    })
    rows.observe({ ...START_BASH, description: 'duplicate start' })

    expect(items).toHaveLength(writes)
    expect(turnOpens).toHaveLength(opens)
    expect(latest()).toMatchObject({ state: 'blocked', summary: 'first run failed' })
  })

  it('does not reopen a turn when a settled session receives a late outcome', () => {
    const { rows, latest, turnOpens } = harness()
    rows.observe(START_BASH)
    rows.settleSession()
    const opens = turnOpens.length

    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: START_BASH.task_id,
      status: 'failed',
      summary: 'late outcome'
    })

    expect(turnOpens).toHaveLength(opens)
    expect(latest()).toMatchObject({ state: 'blocked', summary: 'late outcome' })
  })

  it('reopens a settled row when Claude re-announces the same task id with a new tool id', () => {
    const { rows, latest } = harness()
    rows.observe({ ...START_BASH, task_id: 'resume-1', tool_use_id: 'toolu_first' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'resume-1',
      tool_use_id: 'toolu_first',
      status: 'completed',
      summary: 'first run finished'
    })
    expect(latest()).toMatchObject({ state: 'done', summary: 'first run finished' })

    rows.observe({
      ...START_BASH,
      task_id: 'resume-1',
      tool_use_id: 'toolu_second',
      status: 'running',
      description: 'Second run'
    })
    expect(latest()).toMatchObject({ state: 'working', label: 'Second run' })
    expect(latest()).not.toHaveProperty('summary')

    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'resume-1',
      tool_use_id: 'toolu_second',
      status: 'failed',
      summary: 'second run failed'
    })
    expect(latest()).toMatchObject({ state: 'blocked', summary: 'second run failed' })
  })

  // Aggregate entries carry identity fields without per-task status.
  it('takes identity from the aggregate roster', () => {
    const { rows, latest } = harness()
    rows.observe({ ...START_BASH, task_id: 'aggregate-1', description: undefined })
    expect(latest()).toMatchObject({ label: '', state: 'working' })

    rows.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'aggregate-1', task_type: 'local_bash', description: 'Named by roster' }]
    })

    expect(latest()).toMatchObject({ label: 'Named by roster', state: 'working' })
  })

  it('does not let mere presence in the live set revive a settled row', () => {
    const { rows, latest } = harness()
    rows.observe({ ...START_BASH, task_id: 'aggregate-2' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'aggregate-2',
      status: 'completed'
    })
    expect(latest()).toMatchObject({ state: 'done' })

    rows.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'aggregate-2', task_type: 'local_bash', description: 'still listed' }]
    })

    expect(latest()).toMatchObject({ state: 'done' })
  })

  it('excludes ambient housekeeping from the aggregate roster', () => {
    const { rows, latest } = harness()
    rows.observe({ ...START_BASH, task_id: 'aggregate-3', description: undefined })
    rows.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'aggregate-3',
          task_type: 'local_bash',
          description: 'housekeeping name',
          ambient: true
        }
      ]
    })
    expect(latest()).toMatchObject({ label: '' })
  })

  it('never burns a revision on a duplicate delivery', () => {
    const { rows, items } = harness()
    rows.observe(START_BASH)
    const afterStart = items.length
    rows.observe(START_BASH)
    expect(items.length).toBe(afterStart)
  })

  it('claims a resumed task announced under a new tool id', () => {
    const { rows, items, latest } = harness()
    rows.observe(START_BASH)
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'toolu_01CqPd7y',
      status: 'failed',
      summary: 'it failed'
    })
    expect(items.at(-1)?.identity).toMatchObject({
      clientMessageId: 'claude-background-task:byjnee2no'
    })
    expect(latest()).toMatchObject({ taskId: 'byjnee2no', state: 'blocked' })
  })

  it('rejects overlong tool-use aliases instead of clipping them into collisions', () => {
    const { rows, items, latest } = harness()
    rows.observe({ ...START_BASH, task_id: 'task-a' })
    const afterStart = items.length

    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: `${'x'.repeat(512)}A`,
        status: 'failed',
        summary: 'misattributed failure'
      })
    ).toBe(false)
    expect(items).toHaveLength(afterStart)
    expect(latest()).toMatchObject({ taskId: 'task-a', state: 'working' })
  })

  it('evicts settled rows so the lifetime cap cannot drop a later failure', () => {
    const { rows, latest } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `settled-${index}` })
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: `settled-${index}`,
        status: 'completed'
      })
    }

    rows.observe({ ...START_BASH, task_id: 'overflow' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'overflow',
      status: 'failed',
      summary: 'overflow failed'
    })

    expect(latest()).toMatchObject({
      taskId: 'overflow',
      state: 'blocked',
      summary: 'overflow failed'
    })
  })

  it('reopens a settled task after its row was evicted when the parent alias changes', () => {
    const { rows, keys, latest } = harness([FORWARDED_TOOL, 'toolu_second'])
    rows.observe({ ...START_BASH, task_id: 'evicted-restart' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'evicted-restart',
      tool_use_id: FORWARDED_TOOL,
      status: 'completed'
    })
    for (let index = 0; index < 63; index += 1) {
      rows.observe({ ...START_BASH, task_id: `settled-${index}` })
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: `settled-${index}`,
        status: 'completed'
      })
    }
    rows.observe({ ...START_BASH, task_id: 'evictor' })
    rows.observe({
      ...START_BASH,
      task_id: 'evicted-restart',
      tool_use_id: 'toolu_second',
      description: 'second invocation'
    })

    expect([...new Set(keys())]).toContain('claude-background-task:evicted-restart#2')
    expect(latest()).toMatchObject({
      taskId: 'evicted-restart',
      state: 'working',
      label: 'second invocation'
    })
  })

  it('bounds generation history without reusing an evicted durable identity', () => {
    const { rows, keys, latest } = harness([FORWARDED_TOOL, 'toolu_second'])
    rows.observe({ ...START_BASH, task_id: 'generation-reused' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'generation-reused',
      status: 'completed'
    })
    rows.observe({ ...START_BASH, task_id: 'generation-reused', tool_use_id: 'toolu_second' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'generation-reused',
      tool_use_id: 'toolu_second',
      status: 'completed'
    })
    for (let index = 0; index < 513; index += 1) {
      const taskId = `generation-${index}`
      rows.observe({ ...START_BASH, task_id: taskId })
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        status: 'completed'
      })
    }

    rows.observe({ ...START_BASH, task_id: 'generation-reused' })
    rows.observe({
      ...START_BASH,
      task_id: 'generation-0',
      tool_use_id: 'toolu_second',
      description: 'reused after ledger eviction'
    })

    const identities = new Set(keys())
    expect(identities).toContain('claude-background-task:generation-reused#2')
    expect(identities).toContain('claude-background-task:generation-reused#4')
    expect(identities).toContain('claude-background-task:generation-0')
    expect(identities).toContain('claude-background-task:generation-0#5')
    expect(latest()).toMatchObject({
      taskId: 'generation-0',
      state: 'working',
      label: 'reused after ledger eviction'
    })

    expect(rows.ledgerSizes.generations).toBeLessThanOrEqual(512)
  })

  it('declines coverage so the fallback still reports when every row slot is live', () => {
    const { rows } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }
    expect(rows.observe({ ...START_BASH, task_id: 'overflow-live' })).toBe(false)
  })

  it('keeps one overflow terminal row across its update and notification', () => {
    const { rows, keys, latest } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }

    expect(rows.observe({ ...START_BASH, task_id: 'overflow-fallback' })).toBe(false)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'overflow-fallback',
        patch: { status: 'failed' }
      })
    ).toBe(true)
    expect(keys().filter((id) => id === 'claude-background-task:overflow-fallback')).toHaveLength(1)
    expect(latest()).toMatchObject({ state: 'blocked' })
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'overflow-fallback',
        status: 'failed',
        summary: 'overflow failed'
      })
    ).toBe(true)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'overflow-fallback',
        usage: { total_tokens: 3 }
      })
    ).toBe(true)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'overflow-fallback',
        status: 'failed',
        summary: 'duplicate overflow failed'
      })
    ).toBe(true)
    expect(keys().filter((id) => id === 'claude-background-task:overflow-fallback')).toHaveLength(2)
    expect(latest()).toMatchObject({ state: 'blocked', summary: 'overflow failed' })
  })

  it('lets the final notification correct a provisional failed update', () => {
    const { rows, latest, latestTwin } = harness()
    rows.observe(START_BASH)
    rows.observe({ ...FAILED_UPDATE, task_id: START_BASH.task_id })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: START_BASH.task_id,
      status: 'stopped',
      summary: 'No completion record was found'
    })

    expect(latest()).toMatchObject({ state: 'idle', summary: 'No completion record was found' })
    expect(latestTwin()).toBe('No completion record was found')
  })

  it('corrects a capacity-refused failed update with the final stopped verdict', () => {
    const { rows, latest, keys } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }
    rows.observe({ ...START_BASH, task_id: 'overflow-stopped' })
    rows.observe({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'overflow-stopped',
      patch: { status: 'failed' }
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'overflow-stopped',
      status: 'stopped',
      summary: 'No completion record was found'
    })

    expect(latest()).toMatchObject({ state: 'idle', summary: 'No completion record was found' })
    expect(keys().filter((id) => id === 'claude-background-task:overflow-stopped')).toHaveLength(2)
  })

  it('preserves a fallback run alias across a duplicate terminal without one', () => {
    const { rows, latest } = harness([FORWARDED_TOOL, 'toolu_second'])
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }

    expect(rows.observe({ ...START_BASH, task_id: 'overflow-restart' })).toBe(false)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'overflow-restart',
        tool_use_id: FORWARDED_TOOL,
        status: 'completed'
      })
    ).toBe(true)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'overflow-restart',
        status: 'completed'
      })
    ).toBe(true)

    // Free a slot; retain the prior terminal alias so the new invocation can prove a restart.
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'live-0',
      status: 'completed'
    })
    expect(
      rows.observe({
        ...START_BASH,
        task_id: 'overflow-restart',
        tool_use_id: 'toolu_second',
        description: 'second overflow run'
      })
    ).toBe(true)
    expect(latest()).toMatchObject({
      taskId: 'overflow-restart',
      state: 'working',
      label: 'second overflow run'
    })
  })

  it('bounds foreign-owner memory for tasks rendered elsewhere', () => {
    const { rows } = harness()
    for (let index = 0; index < 600; index += 1) {
      rows.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: `agent-${index}`,
        task_type: 'local_agent',
        subagent_type: 'explorer'
      })
    }

    expect(rows.ledgerSizes.foreign).toBeLessThanOrEqual(512)
  })

  it('bounds fallback ownership memory for capacity-refused tasks', () => {
    const { rows } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }
    for (let index = 0; index < 600; index += 1) {
      rows.observe({ ...START_BASH, task_id: `overflow-${index}` })
    }

    expect(rows.ledgerSizes.fallbackTaskIds).toBeLessThanOrEqual(512)
  })

  it('bounds settled overflow rows while preserving the evicted outcome', () => {
    const { rows, keys } = harness()
    for (let index = 0; index < 64; index += 1) {
      rows.observe({ ...START_BASH, task_id: `live-${index}` })
    }
    for (let index = 0; index < 513; index += 1) {
      const id = `overflow-${index}`
      rows.observe({ ...START_BASH, task_id: id })
      rows.observe({
        type: 'system',
        subtype: 'task_updated',
        task_id: id,
        patch: { status: 'failed' }
      })
    }
    const beforeRedelivery = keys().length
    expect(rows.ledgerSizes.overflowTerminalRows).toBeLessThanOrEqual(512)
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'overflow-0',
      status: 'failed',
      summary: 'late outcome'
    })
    expect(keys()).toHaveLength(beforeRedelivery)
    expect(keys()).toContain('claude-background-task:overflow-0')
  })

  it('loses contact rather than claiming an outcome when the provider goes away', () => {
    const { rows, latest, latestTwin } = harness()
    rows.observe(START_BASH)
    rows.dispose()
    expect(latest()).toMatchObject({ state: 'unverifiable' })
    // Older clients read this sentence without understanding the typed task block.
    expect(latestTwin()).toBe(
      'Background command "Wait for the verification verdict" stopped reporting'
    )
  })

  it('states only that a live task was started, never that it is still running', () => {
    const { rows, latestTwin } = harness()
    rows.observe(START_BASH)
    expect(latestTwin()).toBe('Started background command "Wait for the verification verdict"')
  })

  it('declines frames it does not own', () => {
    const { rows } = harness()
    expect(rows.observe({ type: 'system', subtype: 'init' })).toBe(false)
    expect(rows.observe({ type: 'assistant' })).toBe(false)
    expect(rows.observe({ type: 'system', subtype: 'task_started', task_id: 'x' })).toBe(true)
  })
  it('admits a task type it does not recognise as no task at all', () => {
    const { rows, items } = harness()
    rows.observe({ ...START_BASH, task_id: 'weird-1', task_type: 'local_teleport' })
    expect(items).toEqual([])
  })

  it('gives a reused task id a fresh row instead of overwriting the finished run', () => {
    const { rows, keys, latest } = harness([FORWARDED_TOOL, 'toolu_second_run'])
    rows.observe(START_BASH)
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'byjnee2no',
      status: 'failed',
      summary: 'first run failed'
    })
    rows.observe({ ...START_BASH, tool_use_id: 'toolu_second_run' })
    const written = [...new Set(keys())]
    expect(written).toEqual([
      'claude-background-task:byjnee2no',
      'claude-background-task:byjnee2no#2'
    ])
    expect(latest()).toMatchObject({ state: 'working', parentToolUseId: 'toolu_second_run' })
  })

  it('carries the spawning tool call on the row', () => {
    const { rows, latest } = harness()
    rows.observe(START_BASH)
    expect(latest()).toMatchObject({ parentToolUseId: FORWARDED_TOOL })
  })

  it('does not re-open a task that is already running', () => {
    // Redelivery cannot revise metadata on an already visible run.
    const { rows, items, latest } = harness()
    rows.observe({ ...START_BASH, description: undefined })
    const afterStart = items.length
    expect(latest()).toMatchObject({ label: '', state: 'working' })

    rows.observe({ ...START_BASH, description: 'Named on redelivery' })
    expect(items.length).toBe(afterStart)
    expect(latest()).toMatchObject({ label: '' })
  })
})
