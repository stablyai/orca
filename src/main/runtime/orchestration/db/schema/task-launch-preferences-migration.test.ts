import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('upgrades tasks without defaults and preserves new defaults across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-task-models-'))
  directories.push(directory)
  const path = join(directory, 'orchestration.db')
  const before = new OrchestrationDb(path)
  const original = before.createTask({ runId: 'run_legacy_local', spec: 'Existing task' })
  before.close()

  const raw = new Database(path)
  raw.exec('ALTER TABLE tasks DROP COLUMN model')
  raw.exec('ALTER TABLE tasks DROP COLUMN effort')
  raw.pragma('user_version = 48')
  raw.close()

  const upgraded = new OrchestrationDb(path)
  let taskId: string
  try {
    expect(upgraded.getTask(original.id)).toMatchObject({
      spec: 'Existing task',
      model: null,
      effort: null
    })
    taskId = upgraded.createTask({
      runId: 'run_legacy_local',
      spec: 'Plan',
      model: 'gpt-6.1-sol',
      effort: 'high'
    }).id
  } finally {
    upgraded.close()
  }

  const reopened = new OrchestrationDb(path)
  try {
    expect(reopened.getTask(taskId)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(reopened.listTasks()).toContainEqual(
      expect.objectContaining({
        id: taskId,
        model: 'gpt-6.1-sol',
        effort: 'high'
      })
    )
    expect(reopened.listTasksWithDispatch()).toContainEqual(
      expect.objectContaining({
        id: taskId,
        model: 'gpt-6.1-sol',
        effort: 'high'
      })
    )
  } finally {
    reopened.close()
  }
})
