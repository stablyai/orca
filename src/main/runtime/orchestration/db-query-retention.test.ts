import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  orchestrationRowRetainedUtf8Bytes,
  ORCHESTRATION_JSON_STRUCTURE_LIMITS,
  ORCHESTRATION_QUERY_MAX_RETAINED_UTF8_BYTES,
  ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES,
  ORCHESTRATION_QUERY_MAX_ROWS,
  ORCHESTRATION_WRITE_MAX_ITEMS,
  ORCHESTRATION_WRITE_MAX_UTF8_BYTES,
  parseOrchestrationJson
} from './query-retention'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function paneKey(index: number, tab = `tab_${index}`): string {
  return `${tab}:00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

describe('OrchestrationDb query retention', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('returns unread rows in stable bounded pages that can be drained successively', () => {
    const d = createDb()
    const inserted = Array.from({ length: ORCHESTRATION_QUERY_MAX_ROWS + 2 }, (_, index) =>
      d.insertMessage({ from: 'sender', to: 'worker', subject: `message-${index}` })
    )

    const first = d.getUnreadMessages('worker')
    expect(first.map((row) => row.id)).toEqual(
      inserted.slice(0, ORCHESTRATION_QUERY_MAX_ROWS).map((row) => row.id)
    )

    d.markAsRead(first.map((row) => row.id))
    expect(d.getUnreadMessages('worker').map((row) => row.id)).toEqual(
      inserted.slice(ORCHESTRATION_QUERY_MAX_ROWS).map((row) => row.id)
    )
  })

  it('drains undelivered rows successively without replaying the first page', () => {
    const d = createDb()
    const inserted = Array.from({ length: ORCHESTRATION_QUERY_MAX_ROWS + 1 }, (_, index) =>
      d.insertMessage({ from: 'sender', to: 'worker', subject: `delivery-${index}` })
    )

    const first = d.getUndeliveredUnreadMessages('worker')
    d.markAsDelivered(first.map((row) => row.id))

    expect(d.getUndeliveredUnreadMessages('worker').map((row) => row.id)).toEqual([
      inserted.at(-1)!.id
    ])
  })

  it('caps aggregate retained bytes and resumes at the first omitted message', () => {
    const d = createDb()
    const body = 'x'.repeat(500 * 1024)
    const inserted = Array.from({ length: 20 }, (_, index) =>
      d.insertMessage({ from: 'sender', to: 'worker', subject: `large-${index}`, body })
    )

    const first = d.getUnreadMessages('worker')
    const retainedBytes = first.reduce(
      (total, row) => total + orchestrationRowRetainedUtf8Bytes(row),
      0
    )
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(inserted.length)
    expect(retainedBytes).toBeLessThanOrEqual(ORCHESTRATION_QUERY_MAX_RETAINED_UTF8_BYTES)

    d.markAsRead(first.map((row) => row.id))
    expect(d.getUnreadMessages('worker')[0]?.id).toBe(inserted[first.length].id)
  })

  it('rejects new oversized rows and skips oversized legacy rows without starving later rows', () => {
    const d = createDb()
    const exactSubject = 'x'.repeat(ORCHESTRATION_WRITE_MAX_UTF8_BYTES - 2)
    expect(d.insertMessage({ from: 'a', to: 'b', subject: exactSubject }).subject).toBe(
      exactSubject
    )
    expect(() => d.insertMessage({ from: 'a', to: 'b', subject: `${exactSubject}x` })).toThrow(
      /orchestration limit/
    )

    sqliteFor(d)
      .prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject, body)
         VALUES (?, 'a', 'legacy', 'oversized', ?)`
      )
      .run('msg_oversized', 'z'.repeat(ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES + 1))
    const later = d.insertMessage({ from: 'a', to: 'legacy', subject: 'later-valid-row' })

    expect(d.getMessageById('msg_oversized')).toBeUndefined()
    expect(d.getUnreadMessages('legacy').map((row) => row.id)).toEqual([later.id])
  })

  it('keeps exact task counts and promotes dependencies beyond the returned page', () => {
    const d = createDb()
    const parent = d.createTask({ spec: 'parent' })
    const children = Array.from({ length: ORCHESTRATION_QUERY_MAX_ROWS + 1 }, (_, index) =>
      d.createTask({ spec: `child-${index}`, deps: [parent.id] })
    )

    expect(d.listTasks()).toHaveLength(ORCHESTRATION_QUERY_MAX_ROWS)
    expect(d.getTaskStatusCounts()).toMatchObject({
      total: ORCHESTRATION_QUERY_MAX_ROWS + 2,
      pending: ORCHESTRATION_QUERY_MAX_ROWS + 1,
      ready: 1
    })

    d.updateTaskStatus(parent.id, 'completed')

    expect(d.getTask(children.at(-1)!.id)?.status).toBe('ready')
    expect(d.getTaskStatusCounts()).toMatchObject({
      total: ORCHESTRATION_QUERY_MAX_ROWS + 2,
      completed: 1,
      ready: ORCHESTRATION_QUERY_MAX_ROWS + 1
    })
  })

  it('rejects dependency amplification and promotes valid rows after oversized legacy DAG data', () => {
    const d = createDb()
    const parent = d.createTask({ spec: 'parent' })
    expect(() =>
      d.createTask({
        spec: 'too many deps',
        deps: Array.from({ length: ORCHESTRATION_WRITE_MAX_ITEMS + 1 }, () => parent.id)
      })
    ).toThrow(/item orchestration limit/)

    sqliteFor(d)
      .prepare(
        `INSERT INTO tasks (id, spec, status, deps)
         VALUES ('task_legacy_amplified', 'legacy', 'pending', ?)`
      )
      .run(
        JSON.stringify(Array.from({ length: ORCHESTRATION_WRITE_MAX_ITEMS + 1 }, () => parent.id))
      )
    const valid = d.createTask({ spec: 'valid', deps: [parent.id] })

    d.updateTaskStatus(parent.id, 'completed')

    expect(d.getTask('task_legacy_amplified')?.status).toBe('pending')
    expect(d.getTask(valid.id)?.status).toBe('ready')
  })

  it('streams active pane and stale-dispatch scans beyond the returned page', () => {
    const d = createDb()
    const contexts = Array.from({ length: ORCHESTRATION_QUERY_MAX_ROWS + 1 }, (_, index) => {
      const task = d.createTask({ spec: `task-${index}` })
      return d.createDispatchContext(task.id, `worker-${index}`, paneKey(index))
    })
    const duplicateTask = d.createTask({ spec: 'duplicate pane' })

    expect(() =>
      d.createDispatchContext(
        duplicateTask.id,
        'reminted-worker',
        paneKey(ORCHESTRATION_QUERY_MAX_ROWS, 'reminted-tab')
      )
    ).toThrow(/already has an active dispatch/)

    sqliteFor(d)
      .prepare(
        "UPDATE dispatch_contexts SET dispatched_at = '2020-01-01 00:00:00', last_heartbeat_at = NULL"
      )
      .run()
    const threshold = '2021-01-01T00:00:00.000Z'
    expect(d.getStaleDispatches(threshold)).toHaveLength(ORCHESTRATION_QUERY_MAX_ROWS)

    const visited: string[] = []
    d.forEachStaleDispatch(threshold, (row) => {
      visited.push(row.id)
    })
    expect(visited).toEqual(contexts.map((row) => row.id))
  })

  it('repairs every pending-gate task even when the gate list is capped', () => {
    const d = createDb()
    const rejectedTask = d.createTask({ spec: 'reject amplified options' })
    expect(() =>
      d.createGate({
        taskId: rejectedTask.id,
        question: 'too many',
        options: Array.from({ length: ORCHESTRATION_WRITE_MAX_ITEMS + 1 }, () => '')
      })
    ).toThrow(/item orchestration limit/)
    const tasks = Array.from({ length: ORCHESTRATION_QUERY_MAX_ROWS + 1 }, (_, index) => {
      const task = d.createTask({ spec: `gated-${index}` })
      d.createGate({ taskId: task.id, question: `question-${index}` })
      return task
    })

    expect(d.listGates({ status: 'pending' })).toHaveLength(ORCHESTRATION_QUERY_MAX_ROWS)
    sqliteFor(d).prepare("UPDATE tasks SET status = 'ready'").run()

    d.restorePendingGateTaskStatuses()

    expect(d.getTask(tasks.at(-1)!.id)?.status).toBe('blocked')
    expect(d.getTaskStatusCounts()).toMatchObject({
      blocked: ORCHESTRATION_QUERY_MAX_ROWS + 1,
      ready: 1
    })
  })
})

describe('orchestration JSON structure admission', () => {
  it('admits the exact structural-token limit and rejects limit +1', () => {
    const exactValues = ORCHESTRATION_JSON_STRUCTURE_LIMITS.structuralTokens - 1
    const exact = `[${Array.from({ length: exactValues }, () => '0').join(',')}]`
    const over = `${exact.slice(0, -1)},0]`

    expect(parseOrchestrationJson(exact)).toHaveLength(exactValues)
    expect(() => parseOrchestrationJson(over)).toThrow(/JSON structure exceeds/)
  })

  it('admits the exact nesting limit and rejects limit +1', () => {
    const depth = ORCHESTRATION_JSON_STRUCTURE_LIMITS.nestingDepth
    const exact = `${'['.repeat(depth)}0${']'.repeat(depth)}`
    const over = `[${exact}]`

    expect(parseOrchestrationJson(exact)).toBeDefined()
    expect(() => parseOrchestrationJson(over)).toThrow(/JSON nesting exceeds/)
  })
})
