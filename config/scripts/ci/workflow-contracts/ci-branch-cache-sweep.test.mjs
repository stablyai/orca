import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/ci-branch-cache-sweep.yml', 'utf8'))
const step = workflow.jobs.sweep.steps[0]
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString()

function sweep(caches, { dryRun = false, remove = vi.fn().mockResolvedValue(undefined) } = {}) {
  const result = runInNewContext(`(async () => { ${step.with.script} })()`, {
    context: { repo: { owner: 'owner', repo: 'repo' } },
    github: {
      paginate: vi.fn().mockResolvedValue(caches),
      rest: { actions: { getActionsCacheList: vi.fn(), deleteActionsCacheById: remove } }
    },
    core: { info: vi.fn() },
    process: { env: { DRY_RUN: String(dryRun) } }
  })
  return { result, remove }
}

it('runs trusted code on a schedule and only dry-runs by default when dispatched', () => {
  expect(Object.keys(workflow.on)).toEqual(['schedule', 'workflow_dispatch'])
  expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
  expect(workflow.permissions).toEqual({ actions: 'write' })
  expect(workflow.jobs.sweep.steps).toHaveLength(1)
  expect(step.env.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}")
})

it('deletes only idle caches on non-default branches', async () => {
  const { result, remove } = sweep([
    { id: 1, ref: 'refs/heads/scratch', last_accessed_at: hoursAgo(7) },
    { id: 2, ref: 'refs/heads/scratch', last_accessed_at: hoursAgo(1) },
    { id: 3, ref: 'refs/heads/main', last_accessed_at: hoursAgo(48) },
    { id: 4, ref: 'refs/pull/9/merge', last_accessed_at: hoursAgo(48) },
    { id: 5, ref: 'refs/tags/mobile-ios-v1.0.0', last_accessed_at: hoursAgo(48) },
    { id: 6, ref: 'refs/heads/other', last_accessed_at: 'not a date' }
  ])
  await result
  expect(remove.mock.calls).toEqual([[{ owner: 'owner', repo: 'repo', cache_id: 1 }]])
})

it('lists without deleting on a dry run', async () => {
  const { result, remove } = sweep(
    [{ id: 1, ref: 'refs/heads/scratch', last_accessed_at: hoursAgo(7) }],
    { dryRun: true }
  )
  await result
  expect(remove).not.toHaveBeenCalled()
})

it('tolerates an eviction race but surfaces permission failures', async () => {
  const idle = [{ id: 1, ref: 'refs/heads/scratch', last_accessed_at: hoursAgo(7) }]
  await expect(
    sweep(idle, { remove: vi.fn().mockRejectedValue({ status: 404 }) }).result
  ).resolves.toBeUndefined()
  await expect(
    sweep(idle, { remove: vi.fn().mockRejectedValue({ status: 403 }) }).result
  ).rejects.toEqual({ status: 403 })
})
