import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/ci-closed-pr-caches.yml', 'utf8'))
const script = workflow.jobs.clean.steps[1].with.script
const ref = 'refs/pull/123/merge'

function run(caches, remove = vi.fn().mockResolvedValue(undefined)) {
  const list = vi.fn()
  const paginate = vi.fn().mockResolvedValue(caches)
  const result = runInNewContext(`(async () => { ${script} })()`, {
    context: { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 123 } } },
    github: {
      paginate,
      rest: { actions: { getActionsCacheList: list, deleteActionsCacheById: remove } }
    },
    core: { info: vi.fn() }
  })
  return { result, remove, paginate, list }
}

it('uses default-branch code without checking out a closed PR', () => {
  expect(workflow.on).toEqual({ pull_request_target: { types: ['closed'] } })
  expect(workflow.permissions).toEqual({ actions: 'write', 'pull-requests': 'read' })
  expect(workflow.jobs.clean.steps).toHaveLength(2)
  expect(workflow.jobs.clean.steps.every((step) => step.uses === 'actions/github-script@v8')).toBe(
    true
  )
})

it('lists and deletes only caches scoped to the closed merge ref', async () => {
  const { result, paginate, list, remove } = run([
    { id: 12, ref },
    { id: 13, ref }
  ])
  await result
  expect(paginate).toHaveBeenCalledWith(list, { owner: 'owner', repo: 'repo', ref, per_page: 100 })
  expect(remove.mock.calls).toEqual([
    [{ owner: 'owner', repo: 'repo', cache_id: 12 }],
    [{ owner: 'owner', repo: 'repo', cache_id: 13 }]
  ])
})

it('refuses a default-branch cache even if the API returns one', async () => {
  const { result, remove } = run([{ id: 12, ref: 'refs/heads/main' }])
  await expect(result).rejects.toThrow('Unexpected cache ref')
  expect(remove).not.toHaveBeenCalled()
})

it('tolerates an eviction race but surfaces permission failures', async () => {
  await expect(
    run([{ id: 12, ref }], vi.fn().mockRejectedValue({ status: 404 })).result
  ).resolves.toBeUndefined()
  await expect(
    run([{ id: 12, ref }], vi.fn().mockRejectedValue({ status: 403 })).result
  ).rejects.toEqual({ status: 403 })
})
