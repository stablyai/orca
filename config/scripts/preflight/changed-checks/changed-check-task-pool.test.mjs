import { expect, it } from 'vitest'
import { runChangedCheckTasks } from './changed-check-task-pool.mjs'

it('isolates resource checks, retains a failed check and runs every remaining check within the cap', async () => {
  const names = ['types', 'tests', 'lint', 'format', 'links']
  const started = new Map(names.map((name) => [name, Promise.withResolvers()]))
  const releases = new Map(names.map((name) => [name, Promise.withResolvers()]))
  const active = new Set()
  let peak = 0
  const tasks = names.map((name) => ({ name, exclusive: ['types', 'tests'].includes(name) }))
  const pending = runChangedCheckTasks(
    tasks,
    2,
    async (task) => {
      active.add(task.name)
      peak = Math.max(peak, active.size)
      started.get(task.name).resolve()
      await releases.get(task.name).promise
      active.delete(task.name)
      return { task, ok: task.name !== 'types' }
    },
    undefined,
    { isolateResourceChecks: true }
  )

  await started.get('types').promise
  expect([...active]).toEqual(['types'])
  releases.get('types').resolve()
  await started.get('tests').promise
  expect([...active]).toEqual(['tests'])
  releases.get('tests').resolve()
  await Promise.all([started.get('lint').promise, started.get('format').promise])
  expect([...active]).toEqual(['lint', 'format'])
  releases.get('lint').resolve()
  await started.get('links').promise
  expect([...active]).toEqual(['format', 'links'])
  releases.get('format').resolve()
  releases.get('links').resolve()
  const results = await pending
  expect(results.map(({ task }) => task.name).sort()).toEqual([
    'format',
    'links',
    'lint',
    'tests',
    'types'
  ])
  expect(results.filter(({ ok }) => !ok).map(({ task }) => task.name)).toEqual(['types'])
  expect(peak).toBe(2)
})

it('retains the default concurrent admission of resource checks', async () => {
  const both = Promise.withResolvers()
  const release = Promise.withResolvers()
  const active = []
  const pending = runChangedCheckTasks(
    [
      { name: 'types', exclusive: true },
      { name: 'tests', exclusive: true }
    ],
    2,
    async (task) => {
      active.push(task.name)
      if (active.length === 2) {
        both.resolve()
      }
      await release.promise
      return task.name
    }
  )
  await both.promise
  expect(active).toEqual(['types', 'tests'])
  release.resolve()
  expect(await pending).toEqual(['types', 'tests'])
})
