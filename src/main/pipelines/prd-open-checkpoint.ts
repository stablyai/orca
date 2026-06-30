import type { PipelineDb } from './db'
import type { PipelineRuntimeExecutorAdapter } from './runtime-executor-types'
import type { PipelineRun } from '../../shared/pipelines-types'

export async function ensureParentPrdOpen(input: {
  db: PipelineDb
  run: PipelineRun
  runtime: Pick<PipelineRuntimeExecutorAdapter, 'runCommand'>
  cwd: string
}): Promise<boolean> {
  if (input.run.taskSource.type !== 'github_issues') {
    return true
  }
  const command = buildGitHubIssueViewCommand(input.run)
  const result = await input.runtime.runCommand({
    command,
    cwd: input.cwd,
    timeoutSeconds: 60
  })
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`Pipeline PRD checkpoint failed: ${command}`)
  }
  if (parseGitHubIssueState(result.stdout).toLowerCase() === 'open') {
    return true
  }
  input.db.cancelRunForPrdClosed(input.run.id)
  return false
}

function buildGitHubIssueViewCommand(run: PipelineRun): string {
  if (run.taskSource.type !== 'github_issues') {
    throw new Error('Pipeline PRD checkpoint requires a GitHub task source')
  }
  return [
    'gh',
    'issue',
    'view',
    String(run.taskSource.prdIssueNumber),
    '--repo',
    `${run.taskSource.owner}/${run.taskSource.repo}`,
    '--json',
    'number,title,state,url'
  ]
    .map(quoteShellArg)
    .join(' ')
}

function parseGitHubIssueState(stdout: string): string {
  const parsed = JSON.parse(stdout) as { state?: unknown }
  if (typeof parsed.state !== 'string') {
    throw new Error('Pipeline PRD checkpoint returned an invalid issue')
  }
  return parsed.state
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=,+-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}
