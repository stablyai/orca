import { runProcess } from '@orca/process-host'

export type PipelineCheckGateResult = {
  passed: boolean
  output: string
  args: readonly string[]
}

export type PipelineCiWatchResult = {
  passed: boolean
  output: string
  args: readonly string[]
}

export type PipelineMainHealthResult = {
  healthy: boolean
  runId?: number
  conclusion?: string | null
  url?: string
  output: string
}

export type PipelineMergeResult = {
  merged: boolean
  blockedByMainCi?: boolean
  mainCiRunId?: number
  output: string
}

function formatProcessOutput(stdout?: string | null, stderr?: string | null): string {
  return `${stdout ?? ''}\n${stderr ?? ''}`.trim()
}

export async function runPipelineCheckGate(request: {
  workdir: string
  base?: string
  timeoutMs?: number
}): Promise<PipelineCheckGateResult> {
  const args = request.base ? ['check:changed', '--', `--base=${request.base}`] : ['check:changed']
  const result = await runProcess({
    program: 'pnpm',
    args,
    cwd: request.workdir,
    timeoutMs: request.timeoutMs ?? 600_000
  })
  return {
    passed: result.code === 0,
    output: formatProcessOutput(result.stdout, result.stderr),
    args
  }
}

export async function runPipelineCiWatch(request: {
  workdir: string
  prNumber?: number
  runId?: number
  timeoutMs?: number
}): Promise<PipelineCiWatchResult> {
  if (request.prNumber === undefined && request.runId === undefined) {
    return {
      passed: false,
      output: 'Either prNumber or runId is required to watch CI.',
      args: []
    }
  }
  const args =
    request.prNumber !== undefined
      ? ['pr', 'checks', String(request.prNumber), '--watch']
      : ['run', 'watch', String(request.runId), '--compact', '--exit-status']
  const result = await runProcess({
    program: 'gh',
    args,
    cwd: request.workdir,
    timeoutMs: request.timeoutMs ?? 1_800_000
  })
  return {
    passed: result.code === 0,
    output: formatProcessOutput(result.stdout, result.stderr),
    args
  }
}

export async function runPipelineMainHealthCheck(request: {
  workdir: string
  branch?: string
  timeoutMs?: number
}): Promise<PipelineMainHealthResult> {
  const branch = request.branch ?? 'main'
  const result = await runProcess({
    program: 'gh',
    args: [
      'run',
      'list',
      '--branch',
      branch,
      '--limit',
      '1',
      '--json',
      'databaseId,status,conclusion,url'
    ],
    cwd: request.workdir,
    timeoutMs: request.timeoutMs ?? 30_000
  })
  const output = formatProcessOutput(result.stdout, result.stderr)
  if (result.code !== 0) {
    return { healthy: false, output }
  }
  try {
    const runs = JSON.parse(result.stdout ?? '[]') as {
      databaseId?: number
      status?: string
      conclusion?: string | null
      url?: string
    }[]
    const latest = runs[0]
    if (!latest) {
      return { healthy: true, output }
    }
    const failedConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required'])
    const healthy = !latest.conclusion || !failedConclusions.has(latest.conclusion)
    return {
      healthy,
      runId: latest.databaseId,
      conclusion: latest.conclusion,
      url: latest.url,
      output
    }
  } catch {
    return { healthy: false, output }
  }
}

export async function runPipelineMerge(request: {
  workdir: string
  prNumber: number
  method?: 'squash' | 'merge' | 'rebase'
  timeoutMs?: number
}): Promise<PipelineMergeResult> {
  const health = await runPipelineMainHealthCheck({ workdir: request.workdir })
  if (!health.healthy) {
    return {
      merged: false,
      blockedByMainCi: true,
      mainCiRunId: health.runId,
      output: `Main CI is not healthy (${health.conclusion ?? 'unknown'}). Fix main CI before merging.${health.url ? ` ${health.url}` : ''}`
    }
  }
  const method = request.method ?? 'squash'
  const result = await runProcess({
    program: 'gh',
    args: ['pr', 'merge', String(request.prNumber), `--${method}`],
    cwd: request.workdir,
    timeoutMs: request.timeoutMs ?? 60_000
  })
  return {
    merged: result.code === 0,
    output: formatProcessOutput(result.stdout, result.stderr)
  }
}
