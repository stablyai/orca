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
    data: options.nextCurrent ?? options.current ?? current
  }))
  if (options.reopened || options.nextCurrent) {
    getPr.mockResolvedValueOnce({ data: options.reopened ? current : options.current })
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
      payload: { action: options.action ?? 'closed', pull_request: options.closed ?? closed }
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

it('rechecks closure before cancelling when a PR reopens during lookup', async () => {
  const { result, getRun, cancel } = execute({
    current: { ...current, state: 'open' },
    reopened: true
  })
  await result
  expect(getRun).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
})

const head = 'a'.repeat(40)
const pushed = { number: 123, head: { sha: head } }
const open = { ...pushed, state: 'open' }

it('cancels an older commit even when a path filter prevents a replacement run', async () => {
  const { result, cancel } = execute({
    action: 'synchronize',
    closed: pushed,
    current: open,
    run: { head_sha: 'b'.repeat(40) }
  })
  await result
  expect(cancel).toHaveBeenCalledOnce()
})

it('rechecks the current head before cancelling when another push arrives during lookup', async () => {
  const { result, cancel } = execute({
    action: 'synchronize',
    closed: pushed,
    current: open,
    nextCurrent: { ...open, head: { sha: 'b'.repeat(40) } },
    run: { head_sha: 'b'.repeat(40) }
  })
  await result
  expect(cancel).not.toHaveBeenCalled()
})
