import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { findUnboundedPullRequestJobs } from '../../.github/scripts/check-pull-request-job-timeouts.mjs'

it('bounds every job a pull request can start below the 6-hour default', () => {
  expect(findUnboundedPullRequestJobs(parse)).toEqual([])
})

it('reports jobs without a working limit, including jobs of called workflows', () => {
  const parseChanged = (source) => {
    const workflow = parse(source)
    if (workflow.jobs?.selection_evidence) {
      delete workflow.jobs.selection_evidence['timeout-minutes']
    }
    if (workflow.jobs?.code_paths?.['runs-on'] === 'ubuntu-slim') {
      workflow.jobs.code_paths['timeout-minutes'] = 20
    }
    return workflow
  }
  expect(findUnboundedPullRequestJobs(parseChanged)).toEqual([
    'pr.yml code_paths: ubuntu-slim stops jobs at 15 minutes',
    'unit-selection-evidence.yml selection_evidence: set timeout-minutes below 360'
  ])
})

it('checks time limits even when workflow-only changes skip root tests', () => {
  const job = parse(readFileSync('.github/workflows/pr.yml', 'utf8')).jobs.code_paths
  const step = job.steps.find(
    (candidate) => candidate.run === 'bun .github/scripts/check-pull-request-job-timeouts.mjs'
  )
  expect(step).toBeDefined()
  expect(step.if).toBeUndefined()
  const checkout = job.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'))
  expect(checkout.with['sparse-checkout'].split('\n')).toContain(
    '/.github/scripts/check-pull-request-job-timeouts.mjs'
  )
})
