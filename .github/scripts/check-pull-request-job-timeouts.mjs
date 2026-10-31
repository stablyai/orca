import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const WORKFLOWS = '.github/workflows/'
// A job without timeout-minutes runs until GitHub cancels it at 360 minutes, holding the PR's run open.
const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360
// GitHub ends single-CPU ubuntu-slim jobs at 15 minutes, so a longer bound there never applies.
const UBUNTU_SLIM_TIMEOUT_MINUTES = 15

function runsOnPullRequests(workflow) {
  const on = workflow.on
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {})
  return events.some((event) => event === 'pull_request' || event === 'pull_request_target')
}

function bounded(timeout) {
  if (typeof timeout === 'number') {
    return timeout > 0 && timeout < GITHUB_DEFAULT_TIMEOUT_MINUTES
  }
  // ssh-windows-hosts picks its bound per dispatch input; an expression still replaces the default.
  return typeof timeout === 'string' && /^\$\{\{.+\}\}$/.test(timeout.trim())
}

export function findUnboundedPullRequestJobs(parseYaml) {
  const failures = []
  const visited = new Set()
  const visit = (path) => {
    if (visited.has(path)) {
      return
    }
    visited.add(path)
    for (const [id, job] of Object.entries(parseYaml(readFileSync(path, 'utf8')).jobs ?? {})) {
      // A job calling a reusable workflow cannot set timeout-minutes, so the called workflow's jobs stand in.
      if (job.uses) {
        if (job.uses.startsWith(`./${WORKFLOWS}`)) {
          visit(job.uses.slice(2))
        }
        continue
      }
      const name = `${path.slice(WORKFLOWS.length)} ${id}`
      const timeout = job['timeout-minutes']
      if (!bounded(timeout)) {
        failures.push(`${name}: set timeout-minutes below ${GITHUB_DEFAULT_TIMEOUT_MINUTES}`)
      } else if (job['runs-on'] === 'ubuntu-slim' && timeout > UBUNTU_SLIM_TIMEOUT_MINUTES) {
        failures.push(`${name}: ubuntu-slim stops jobs at ${UBUNTU_SLIM_TIMEOUT_MINUTES} minutes`)
      }
    }
  }
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
    if (runsOnPullRequests(parseYaml(readFileSync(`${WORKFLOWS}${file}`, 'utf8')))) {
      visit(`${WORKFLOWS}${file}`)
    }
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const yaml = globalThis.Bun?.YAML
  if (!yaml) {
    throw new Error('Run workflow timeout validation with the pinned Bun runtime.')
  }
  const failures = findUnboundedPullRequestJobs(yaml.parse)
  if (failures.length > 0) {
    throw new Error(`Pull request jobs need a working time limit:\n${failures.join('\n')}`)
  }
  console.log('Every pull request job has a time limit.')
}
