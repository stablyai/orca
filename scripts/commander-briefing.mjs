#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { parseArgs, promisify, stripVTControlCharacters } from 'node:util'

const run = promisify(execFile)

function display(value) {
  return stripVTControlCharacters(String(value)).replace(/\p{Cc}/gu, ' ')
}

async function readOrca(binary, args) {
  let stdout
  try {
    const response = await run(binary, [...args, '--json'], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    stdout = response.stdout
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Orca CLI executable not found. Set --cli to its path.')
    }
    for (const output of [error.stdout, error.stderr]) {
      let response
      try {
        response = JSON.parse(output)
      } catch {
        continue
      }
      if (typeof response.error?.message === 'string') {
        throw new Error(response.error.message)
      }
    }
    throw new Error(error.killed ? 'Orca request timed out.' : `Orca request failed: ${error.code}`)
  }
  const response = JSON.parse(stdout)
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Orca request failed.')
  }
  return response.result
}

async function readHost(host, read, issues) {
  const call = (...args) => read([...args, '--environment', host.id])
  const inspect = async (scope, fn) => {
    try {
      return await fn()
    } catch (error) {
      issues.push({ environment: host.id, scope, message: error.message })
      return null
    }
  }
  const projects = await inspect('projects', async () => {
    const { setups } = await call('project', 'setups')
    return setups.map(({ projectId, hostId, setupState }) => ({
      projectId,
      hostId,
      state: setupState
    }))
  })
  const goals = []
  const cursors = new Set()
  let cursor
  do {
    const page = await inspect('goals', () =>
      call('orchestration', 'run-list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : []))
    )
    if (!page) {
      break
    }
    for (const { id, objective, legacy } of page.runs) {
      if (legacy) {
        continue
      }
      const [tasks, decisions] = await Promise.all([
        inspect(`tasks/${id}`, async () => {
          const { tasks } = await call('orchestration', 'task-list', '--run', id, '--brief')
          const counts = new Map()
          for (const { status } of tasks) {
            counts.set(status, (counts.get(status) ?? 0) + 1)
          }
          return Object.fromEntries(counts)
        }),
        inspect(`decisions/${id}`, async () => {
          const { gates } = await call(
            'orchestration',
            'gate-list',
            '--run',
            id,
            '--status',
            'pending'
          )
          return gates.map(({ id, taskId, question }) => ({ id, taskId, question }))
        })
      ])
      goals.push({ id, objective, tasks, decisions })
    }
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) {
      issues.push({
        environment: host.id,
        scope: 'goals',
        message: 'Run pagination returned a repeated cursor.'
      })
      break
    }
    cursors.add(cursor)
  } while (cursor)
  return { id: host.id, name: host.name, projects, goals }
}

function printBrief({ hosts, issues }) {
  const lines = []
  for (const host of hosts) {
    lines.push(display(host.name))
    for (const project of host.projects ?? []) {
      lines.push(
        `  ${display(project.projectId)} on ${display(project.hostId)} [${display(project.state)}]`
      )
    }
    for (const goal of host.goals) {
      const counts =
        goal.tasks &&
        Object.entries(goal.tasks)
          .map(([state, n]) => `${n} ${display(state)}`)
          .join(', ')
      lines.push(
        `  ${display(goal.objective)} (${display(goal.id)}) — ${
          counts === null ? 'progress unavailable' : counts || 'no tasks'
        }`
      )
      for (const gate of goal.decisions ?? []) {
        lines.push(`    Decision ${display(gate.id)} • ${display(gate.question)}`)
      }
    }
    if (
      host.projects?.length === 0 &&
      !host.goals.length &&
      !issues.some((issue) => issue.environment === host.id)
    ) {
      lines.push('  No registered projects or orchestration goals.')
    }
  }
  for (const issue of issues) {
    lines.push(
      `Incomplete • ${display(issue.environment)} • ${display(issue.scope)} • ${display(
        issue.message
      )}`
    )
  }
  console.log(lines.join('\n'))
}

export async function collectCommanderBriefing({ cli, environment } = {}, read = null) {
  const binary = cli ?? process.env.ORCA_CLI ?? (process.platform === 'linux' ? 'orca-ide' : 'orca')
  const query = read ?? ((args) => readOrca(binary, args))
  const selected = environment
    ? [{ id: environment, name: environment }]
    : (await query(['host', 'list'])).hosts.filter(
        (host) => host.kind === 'local' || host.kind === 'environment'
      )
  const issues = []
  const hosts = []
  for (const host of selected) {
    hosts.push(await readHost(host, query, issues))
  }
  return { hosts, issues }
}

async function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      cli: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  if (values.help) {
    console.log(
      'orca-commander-briefing [--environment <id-or-name>] [--cli <path>] [--json]\nSummarize registered projects, goal progress and pending decisions on local and paired Orca runtimes.'
    )
    return
  }
  const { hosts, issues } = await collectCommanderBriefing(values)
  if (values.json) {
    console.log(JSON.stringify({ hosts, issues }))
  } else {
    printBrief({ hosts, issues })
  }
  if (issues.length) {
    process.exitCode = 2
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(display(error.message))
    process.exitCode = 1
  })
}
