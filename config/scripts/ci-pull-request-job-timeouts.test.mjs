import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const WORKFLOWS = '.github/workflows/'
// A job without timeout-minutes runs until GitHub cancels it at 360 minutes, holding the PR's run open.
const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360
// GitHub ends single-CPU ubuntu-slim jobs at 15 minutes, so a longer bound there never applies.
const UBUNTU_SLIM_TIMEOUT_MINUTES = 15

function readWorkflow(path) {
  return parse(readFileSync(path, 'utf8'))
}

function runsOnPullRequests(workflow) {
  const on = workflow.on
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {})
  return events.some((event) => event === 'pull_request' || event === 'pull_request_target')
}

// A job calling a reusable workflow cannot set timeout-minutes, so the called workflow's jobs stand in.
function pullRequestJobs() {
  const jobs = new Map()
  const visited = new Set()
  const visit = (path) => {
    if (visited.has(path)) {
      return
    }
    visited.add(path)
    for (const [id, job] of Object.entries(readWorkflow(path).jobs ?? {})) {
      if (!job.uses) {
        jobs.set(`${path.slice(WORKFLOWS.length)} ${id}`, job)
      } else if (job.uses.startsWith(`./${WORKFLOWS}`)) {
        visit(job.uses.slice(2))
      }
    }
  }
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
    if (runsOnPullRequests(readWorkflow(`${WORKFLOWS}${file}`))) {
      visit(`${WORKFLOWS}${file}`)
    }
  }
  return jobs
}

function bounded(timeout) {
  if (typeof timeout === 'number') {
    return timeout > 0 && timeout < GITHUB_DEFAULT_TIMEOUT_MINUTES
  }
  // ssh-windows-hosts picks its bound per dispatch input; an expression still replaces the default.
  return typeof timeout === 'string' && /^\$\{\{.+\}\}$/.test(timeout.trim())
}

it('bounds every job a pull request can start below the 6-hour default', () => {
  const unbounded = [...pullRequestJobs()]
    .filter(([, job]) => !bounded(job['timeout-minutes']))
    .map(([name]) => name)
  expect(unbounded).toEqual([])
})

it('keeps ubuntu-slim bounds within the runner cap', () => {
  const unreachable = [...pullRequestJobs()]
    .filter(
      ([, job]) =>
        job['runs-on'] === 'ubuntu-slim' && job['timeout-minutes'] > UBUNTU_SLIM_TIMEOUT_MINUTES
    )
    .map(([name]) => name)
  expect(unreachable).toEqual([])
})

it('covers the PR gate and the jobs of the workflows it calls', () => {
  const names = [...pullRequestJobs().keys()]
  expect(names).toContain('pr.yml preflight')
  expect(names).toContain('unit-selection-evidence.yml selection_evidence')
  expect(names).toContain('cloud-verify.yml test')
})
