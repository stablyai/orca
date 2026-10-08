import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/ci-closed-pr-caches.yml', 'utf8'))
const step = workflow.jobs.clean.steps[0]
const closed = { number: 123, closed_at: '2026-10-06T00:00:00Z' }
const current = { ...closed, state: 'closed', merged_at: null }
const run = {
  id: 42,
  event: 'pull_request',
  path: '.github/workflows/pr.yml',
  status: 'in_progress',
  created_at: '2026-10-05T23:59:00Z'
}

function execute(options = {}) {
  const request = vi.fn(async (_route, args) => {
    if (options.requestError) {
      throw options.requestError
    }
    if (args.concurrency_group_name !== 'pr-checks-123') {
      throw { status: 404 }
    }
    return {
      data: {
        group_name: options.group ?? 'pr-checks-123',
        group_members: options.members ?? [{ run_id: 42 }]
      }
    }
  })
  const getPr = vi.fn(async () => ({
    data: options.current ?? current
  }))
  if (options.reopened) {
    getPr.mockResolvedValueOnce({ data: current })
  }
  const getRun = vi.fn(async () => ({ data: { ...run, ...options.run } }))
  const cancel = vi.fn(async () => {
    if (options.cancelError) {
      throw options.cancelError
    }
  })
  const result = runInNewContext(`(async () => { ${step.with.script} })()`, {
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: options.closed ?? closed }
    },
    github: {
      request,
      rest: {
        pulls: { get: getPr },
        actions: { getWorkflowRun: getRun, cancelWorkflowRun: cancel }
      }
    },
    core: { info: vi.fn() }
  })
  return { result, request, getPr, getRun, cancel }
}

it('uses trusted inline code and only enters cancellation on an unmerged close', () => {
  expect(workflow.on).toEqual({ pull_request_target: { types: ['closed'] } })
  expect(step.if).toBe('github.event.pull_request.merged == false')
  expect(step.uses).toBe('actions/github-script@v8')
  expect(
    workflow.jobs.clean.steps.some((entry) => entry.uses?.startsWith('actions/checkout'))
  ).toBe(false)
})

it('looks up exact PR groups without branch or head-SHA inference', async () => {
  const { result, request, cancel } = execute()
  await result
  expect(request.mock.calls.map(([, args]) => args.concurrency_group_name)).toEqual([
    'pr-checks-123',
    'node-server-123',
    'ssh-windows-hosts-123',
    'ssh-hostile-hosts-123',
    'mobile-123',
    'computer-e2e-123'
  ])
  expect(
    request.mock.calls.every(
      ([route, args]) =>
        route === 'GET /repos/{owner}/{repo}/actions/concurrency_groups/{concurrency_group_name}' &&
        args.headers['X-GitHub-Api-Version'] === '2026-03-10'
    )
  ).toBe(true)
  expect(cancel.mock.calls).toEqual([[{ owner: 'owner', repo: 'repo', run_id: 42 }]])
})

it.each([
  { event: 'push' },
  { event: 'workflow_dispatch' },
  { path: '.github/workflows/release-cut.yml' },
  { status: 'completed' },
  { created_at: '2026-10-06T00:00:01Z' },
  { created_at: 'invalid' }
])('retains unrelated, completed and post-close runs: %j', async (otherRun) => {
  const { result, cancel } = execute({ run: otherRun })
  await result
  expect(cancel).not.toHaveBeenCalled()
})

it.each([
  { ...current, state: 'open' },
  { ...current, merged_at: closed.closed_at },
  { ...current, closed_at: '2026-10-06T00:01:00Z' }
])('retains checks if the closure is no longer current: %j', async (pr) => {
  const { result, request, cancel } = execute({ current: pr })
  await result
  expect(request).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
})

it('rechecks closure before cancelling when a PR reopens during lookup', async () => {
  const { result, getRun, cancel } = execute({
    current: { ...current, state: 'open' },
    reopened: true
  })
  await result
  expect(getRun).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
})

it('ignores job-level leases and invalid run identities', async () => {
  const { result, getRun, cancel } = execute({
    members: [{ run_id: 42, job_id: 1 }, { run_id: '42' }]
  })
  await result
  expect(getRun).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
})

it('refuses a mismatched concurrency group', async () => {
  const { result, cancel } = execute({ group: 'pr-checks-124' })
  await expect(result).rejects.toThrow('Unexpected concurrency group')
  expect(cancel).not.toHaveBeenCalled()
})

it('surfaces lookup and cancellation permission failures', async () => {
  await expect(execute({ requestError: { status: 403 } }).result).rejects.toEqual({ status: 403 })
  await expect(execute({ cancelError: { status: 403 } }).result).rejects.toEqual({ status: 403 })
  await expect(execute({ cancelError: { status: 409 } }).result).resolves.toBeUndefined()
})

it('validates the event identity before looking up any work', async () => {
  const { result, request, getPr } = execute({ closed: { ...closed, number: '123' } })
  await expect(result).rejects.toThrow('Missing closed PR identity')
  expect(request).not.toHaveBeenCalled()
  expect(getPr).not.toHaveBeenCalled()
})
