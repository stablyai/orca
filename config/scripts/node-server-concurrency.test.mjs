import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))

function context(event, runId, inputs = {}) {
  return {
    github: {
      event_name: event,
      run_id: runId,
      ref: 'refs/heads/main',
      event: { pull_request: { number: 123 } }
    },
    inputs: { build_template: false, ref: '', ...inputs },
    matrix: { os: 'windows-2022' },
    format: (template, value) => template.replace('{0}', value)
  }
}

function expression(source, ctx) {
  return runInNewContext(source.slice(3, -2).trim(), ctx)
}

function group(policy, ctx) {
  return policy.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, source) =>
    String(runInNewContext(source, ctx))
  )
}

it('skips draft detection and rechecks the same draft once it is ready', () => {
  const draft = context('pull_request', 1)
  draft.github.event.pull_request.draft = true
  expect(runInNewContext(workflow.jobs.changes.if, draft)).toBe(false)
  draft.github.event.pull_request.draft = false
  expect(runInNewContext(workflow.jobs.changes.if, draft)).toBe(true)
  expect(workflow.on.pull_request.types).toContain('ready_for_review')
  expect(runInNewContext(workflow.jobs.changes.if, context('push', 2))).toBe(true)
  for (const event of ['schedule', 'workflow_dispatch', 'workflow_call']) {
    expect(runInNewContext(workflow.jobs.changes.if, context(event, 2))).toBe(false)
  }
})

it('lets main pushes finish detection without cancelling another push', () => {
  const first = context('push', 1)
  const second = context('push', 2)
  expect(group(workflow.concurrency, first)).not.toBe(group(workflow.concurrency, second))
  expect(expression(workflow.concurrency['cancel-in-progress'], first)).toBe(false)
})

it('still replaces superseded pull requests at workflow level', () => {
  const first = context('pull_request', 1)
  const second = context('pull_request', 2)
  expect(group(workflow.concurrency, first)).toBe(group(workflow.concurrency, second))
  expect(expression(workflow.concurrency['cancel-in-progress'], first)).toBe(true)
})

it.each(['persistence', 'linux_glibc_floor', 'linux_glibc217_compat', 'linux_musl'])(
  '%s only supersedes eligible main qualification, isolating releases and nightly runs',
  (name) => {
    const job = workflow.jobs[name]
    expect(job.if).toContain("needs.changes.outputs.should_run != 'false'")
    const policy = job.concurrency
    const first = context('push', 1)
    const second = context('push', 2)
    expect(group(policy, first)).toBe(group(policy, second))
    expect(expression(policy['cancel-in-progress'], first)).toBe(true)
    for (const [event, inputs] of [
      ['schedule', {}],
      ['workflow_dispatch', {}],
      ['push', { build_template: true }],
      ['push', { ref: 'refs/tags/v1' }]
    ]) {
      const isolated = context(event, 2, inputs)
      expect(group(policy, isolated)).not.toBe(group(policy, first))
      expect(expression(policy['cancel-in-progress'], isolated)).toBe(false)
      expect(group(policy, isolated)).not.toBe(group(policy, context(event, 3, inputs)))
    }
    if (job.strategy?.matrix) {
      second.matrix.os = 'windows-11-arm'
      expect(group(policy, second)).not.toBe(group(policy, first))
    }
  }
)
