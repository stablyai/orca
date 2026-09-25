import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { taskDescription, taskName } from './claude-background-task-frames'

type Retention = 'live' | 'settled' | 'removed'
type Field = 'description' | 'name'
const TASKS = 8
const INPUT_CHARS = 1024 * 1024

function collectHeap(): number {
  const collect = globalThis.gc
  if (typeof collect !== 'function') {
    throw new Error('global.gc unavailable: run with the repository Vitest --expose-gc config')
  }
  for (let index = 0; index < 3; index++) {
    collect()
  }
  return process.memoryUsage().heapUsed
}

function populate(field: Field, retention: Retention, count = TASKS): ClaudeBackgroundTaskTracker {
  const tracker = new ClaudeBackgroundTaskTracker(() => 1)
  const keeper = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'keeper',
    task_type: 'local_bash',
    is_backgrounded: true
  }
  tracker.observe(keeper)
  for (let index = 0; index < count; index++) {
    tracker.observe(
      JSON.parse(
        JSON.stringify({
          ...keeper,
          task_id: `task-${index}`,
          [field]: String.fromCharCode(65 + index).repeat(INPUT_CHARS)
        })
      )
    )
    if (retention === 'settled') {
      tracker.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${index}`,
        status: 'completed'
      })
    }
  }
  if (retention === 'removed') {
    tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [keeper] })
  }
  return tracker
}

it.each([
  ['description', 'live'],
  ['description', 'settled'],
  ['description', 'removed'],
  ['name', 'live'],
  ['name', 'settled'],
  ['name', 'removed']
] as const)('owns bounded %s text retained by %s tasks', async (field, retention) => {
  populate(field, retention, 1).clear()
  await setImmediate()
  const before = collectHeap()
  const tracker = populate(field, retention)
  await setImmediate()
  try {
    expect(collectHeap() - before).toBeLessThan(2 * 1024 * 1024)
    if (retention === 'live') {
      expect(tracker.state?.tasks?.find((task) => task.id === 'task-0')?.[field]).toBe(
        'A'.repeat(512)
      )
    } else if (retention === 'settled') {
      expect(tracker.state?.settledTasks?.find((task) => task.id === 'task-0')?.[field]).toBe(
        'A'.repeat(512)
      )
    } else {
      expect(tracker.state?.tasks?.map((task) => task.id)).toEqual(['keeper'])
    }
  } finally {
    tracker.clear()
  }
})

it('preserves normalization, name fallback, and the UTF-16 clipping boundary', () => {
  expect(taskDescription(' \t run\n the\r\n build ')).toBe('run the build')
  expect(taskDescription(' \t\r\n ')).toBeUndefined()
  expect(taskDescription(null)).toBeUndefined()
  expect(taskName({ name: ' ', agent_type: '\t reviewer\nagent ' })).toBe('reviewer agent')
  const value = `${'漢'.repeat(511)}\ud83d\ude00\udfff`
  expect(taskDescription(value)).toBe(value.slice(0, 512))
  expect(taskName({ subagent_type: value })).toBe(value.slice(0, 512))
})
