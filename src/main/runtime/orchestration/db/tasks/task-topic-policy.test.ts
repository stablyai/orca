import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../orchestration-db'

describe('task topic policy', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('stores one replaceable publish/subscribe policy per task', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'topic routing',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ runId: run.id, spec: 'producer and reviewer' })

    db.setTaskTopicPolicy({
      taskId: task.id,
      runId: run.id,
      publishes: ['findings', 'summary'],
      subscribes: ['review']
    })

    expect(db.getTaskTopicPolicy(task.id)).toEqual({
      taskId: task.id,
      runId: run.id,
      publishes: ['findings', 'summary'],
      subscribes: ['review']
    })
    expect(db.taskPublishesTopic(task.id, 'findings')).toBe(true)
    expect(db.taskPublishesTopic(task.id, 'review')).toBe(false)
    expect(db.listTopicSubscriberTaskIds(run.id, 'review')).toEqual([task.id])

    db.setTaskTopicPolicy({
      taskId: task.id,
      runId: run.id,
      publishes: [],
      subscribes: ['summary']
    })

    expect(db.taskPublishesTopic(task.id, 'findings')).toBe(false)
    expect(db.listTopicSubscriberTaskIds(run.id, 'review')).toEqual([])
    expect(db.listTopicSubscriberTaskIds(run.id, 'summary')).toEqual([task.id])
  })

  it('installs topic cleanup when an existing database predates the policy table', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-topic-policy-upgrade-'))
    const dbPath = join(tempDir, 'orchestration.sqlite')
    db = new OrchestrationDb(dbPath)
    db.db.exec('DROP TRIGGER trg_tasks_delete_topic_policy; DROP TABLE task_topic_policies;')
    db.close()
    db = new OrchestrationDb(dbPath)

    const run = db.createRun({
      objective: 'topic upgrade',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ runId: run.id, spec: 'upgraded task' })
    db.setTaskTopicPolicy({
      taskId: task.id,
      runId: run.id,
      publishes: ['findings'],
      subscribes: ['review']
    })

    db.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)

    expect(db.getTaskTopicPolicy(task.id)).toBeUndefined()
  })

  it('removes policy state with its task', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'topic routing',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ runId: run.id, spec: 'temporary' })
    db.setTaskTopicPolicy({
      taskId: task.id,
      runId: run.id,
      publishes: ['findings'],
      subscribes: ['review']
    })

    db.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)

    expect(db.getTaskTopicPolicy(task.id)).toBeUndefined()
  })
})
