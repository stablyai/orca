// What a TERMINAL background-task frame renders on its own, and what it must
// not. A terminal frame states an outcome, so it is self-sufficient: the row map
// enriches one, it never gates one. The deliberate hand-offs still win, and a
// late announcement still cannot reopen work already reported finished.

import { describe, expect, it } from 'vitest'
import {
  FORWARDED_TOOL,
  harness,
  ORPHAN_FAILED_NOTIFICATION,
  START_BASH
} from './claude-background-task-row-test-support'

describe('claude background task terminal frames', () => {
  it('reports a failure for a task it never saw admitted', () => {
    // The row map ENRICHES a terminal frame; it never gates one. This exact
    // frame reached a user session whose task was never admitted, and both the
    // typed path and the generic fallback stayed silent, so the failure was
    // dropped on the floor.
    const { rows, items, latest, latestTwin, turnOpens } = harness()
    expect(rows.observe(ORPHAN_FAILED_NOTIFICATION)).toBe(true)
    expect(items).toHaveLength(1)
    // The row is provider output like any other, so writing it reopens the turn
    // the provider resumed itself rather than printing beside an idle session.
    expect(turnOpens).toHaveLength(1)
    expect(latest()).toMatchObject({
      type: 'background-task',
      taskId: 'bjzenpq13',
      kind: 'unknown',
      state: 'blocked',
      summary: 'Locate the exact screenshot session',
      parentToolUseId: 'toolu_01ASNfnDBEzt4w3ejLE12bGu'
    })
    // The sentence carries the provider's words; the header falls back to the
    // kind label, so one field is never drawn in two slots of the same row.
    expect(latest()?.label).toBe('')
    expect(latestTwin()).toBe('Locate the exact screenshot session')
  })

  it('carries the error, output path and usage a terminal frame supplies itself', () => {
    const { rows, latest } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'orphan-detailed',
      status: 'failed',
      error: 'exit code 2',
      output_file: '/tmp/orphan-detailed.output',
      usage: { total_tokens: 41 }
    })
    expect(latest()).toMatchObject({
      state: 'blocked',
      error: 'exit code 2',
      outputFile: '/tmp/orphan-detailed.output',
      tokens: 41
    })
  })

  it('reports every terminal outcome it never saw start, not failures alone', () => {
    const { rows, latest } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'quiet-1',
      status: 'completed'
    })
    expect(latest()).toMatchObject({ taskId: 'quiet-1', kind: 'unknown', state: 'done' })

    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'quiet-2',
      status: 'stopped',
      summary: 'the user stopped it'
    })
    expect(latest()).toMatchObject({ taskId: 'quiet-2', state: 'idle' })
  })

  it('leaves agent tasks to the subagent roster', () => {
    const { rows, items } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-agent',
      task_type: 'local_agent',
      subagent_type: 'explorer',
      description: 'Map the lane'
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-agent',
      status: 'failed',
      summary: 'the child failed'
    })
    expect(items).toEqual([])
  })

  it('leaves legacy local_subagent tasks to the subagent roster', () => {
    const { rows, items } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-legacy-agent',
      task_type: 'local_subagent',
      subagent_type: 'explorer'
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-legacy-agent',
      status: 'failed',
      summary: 'the child failed'
    })
    expect(items).toEqual([])
  })

  it('writes nothing for ambient housekeeping the user never asked for', () => {
    const { rows, items } = harness()
    rows.observe({ ...START_BASH, task_id: 'ambient-1', ambient: true })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'ambient-1',
      status: 'failed'
    })
    expect(items).toEqual([])
  })

  it('leaves foreground commands to the ordinary transcript path', () => {
    const { rows, items } = harness()
    expect(
      rows.observe({
        ...START_BASH,
        task_id: 'foreground-1',
        is_backgrounded: false
      })
    ).toBe(true)
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'foreground-1',
        status: 'failed',
        summary: 'foreground command failed'
      })
    ).toBe(true)
    expect(items).toEqual([])
  })

  it('refuses a nested child whose spawning tool was never forwarded', () => {
    // A Task spawned inside a subagent's sidechain names a tool id that only
    // exists in that sidechain. A top-level row for it would claim an
    // invocation the user never saw.
    const { rows, items } = harness([])
    rows.observe({ ...START_BASH, task_id: 'nested-1', tool_use_id: 'toolu_sidechain' })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'nested-1',
      tool_use_id: 'toolu_sidechain',
      status: 'failed',
      summary: 'the nested child failed'
    })
    expect(items).toEqual([])
  })

  it('never lets a monitor reach the timeline', () => {
    // A monitor is Claude's own housekeeping: it runs for the life of the
    // session and has no outcome a transcript row could report.
    const { rows, items } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'monitor-1',
      tool_use_id: FORWARDED_TOOL,
      task_type: 'monitor',
      description: 'Watch the build',
      is_backgrounded: true
    })
    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'monitor-1',
      status: 'failed',
      summary: 'monitor stopped'
    })
    expect(items).toEqual([])
  })

  it('does not resurrect a task whose terminal edge arrived before its start', () => {
    // The guard is scoped to ANNOUNCEMENTS: the terminal frame states an
    // outcome and gets its row, and the late `task_started` that follows may
    // not reopen work already reported finished.
    const { rows, items, keys, latest } = harness()
    expect(
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'done-before-start',
        status: 'completed'
      })
    ).toBe(true)
    expect(items).toHaveLength(1)

    expect(rows.observe({ ...START_BASH, task_id: 'done-before-start' })).toBe(true)
    expect(items).toHaveLength(1)
    expect([...new Set(keys())]).toEqual(['claude-background-task:done-before-start'])
    expect(latest()).toMatchObject({ state: 'done' })
  })

  it('does not resurrect an orphan outcome that named its own parent tool', () => {
    const { rows, items, latest } = harness([
      FORWARDED_TOOL,
      ORPHAN_FAILED_NOTIFICATION.tool_use_id
    ])
    rows.observe(ORPHAN_FAILED_NOTIFICATION)
    rows.observe({
      ...START_BASH,
      task_id: ORPHAN_FAILED_NOTIFICATION.task_id,
      tool_use_id: ORPHAN_FAILED_NOTIFICATION.tool_use_id
    })
    expect(items).toHaveLength(1)
    expect(latest()).toMatchObject({ state: 'blocked' })
  })

  it('does not resurrect after a terminal update that arrived before start', () => {
    const { rows, items } = harness()
    rows.observe({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'updated-before-start',
      patch: { status: 'completed' }
    })
    rows.observe({ ...START_BASH, task_id: 'updated-before-start' })
    expect(items).toEqual([])
  })
})
