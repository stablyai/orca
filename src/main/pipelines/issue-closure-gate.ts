import type { PipelineDb } from './db'
import { runDynamicContextCommand } from './dynamic-context-command-runner'
import { PipelineReviewMergeVerifyError } from './review-merge-verify-errors'
import type { PipelineRun, PipelineTask } from '../../shared/pipelines-types'

export type PipelineIssueStateReader = (input: {
  run: PipelineRun
  task: PipelineTask
  cwd: string
}) => Promise<{ state: string; url: string | null }>

type PipelineIssueStateCommandRunner = (input: {
  command: string
  cwd: string
  timeoutSeconds: number
}) => Promise<{
  command: string
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}>

export async function runIssueClosureGate(input: {
  db: Pick<PipelineDb, 'updateTaskIssueClosure' | 'updateTaskStatus'>
  run: PipelineRun
  tasks: PipelineTask[]
  cwd: string
  issueStateReader?: PipelineIssueStateReader
  verifyCommandRunner?: PipelineIssueStateCommandRunner
}): Promise<void> {
  for (const task of input.tasks.filter((candidate) => candidate.sourceType === 'github_issue')) {
    const closure = await readIssueClosureState(input, task)
    input.db.updateTaskIssueClosure(task.id, { issueClosure: closure })
    if (closure.state.toLowerCase() !== 'closed') {
      const error = new PipelineReviewMergeVerifyError(
        'issue_not_closed',
        `Pipeline task issue #${task.sourceId} remains open`,
        { taskId: task.id, sourceId: task.sourceId, closure }
      )
      input.db.updateTaskStatus(task.id, 'failed', toPipelineError(error))
      throw error
    }
  }
}

async function readIssueClosureState(
  input: {
    run: PipelineRun
    cwd: string
    issueStateReader?: PipelineIssueStateReader
    verifyCommandRunner?: PipelineIssueStateCommandRunner
  },
  task: PipelineTask
): Promise<{ state: string; url: string | null }> {
  if (input.issueStateReader) {
    return input.issueStateReader({ run: input.run, task, cwd: input.cwd })
  }
  const command = buildGitHubIssueStateCommand(input.run, task.sourceId)
  const result = await runIssueStateCommand(input, command)
  if (result.timedOut || result.exitCode !== 0) {
    throw new PipelineReviewMergeVerifyError('issue_state_lookup_failed', command, {
      sourceId: task.sourceId,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    })
  }
  return parseGitHubIssueState(result.stdout)
}

async function runIssueStateCommand(
  input: {
    run: PipelineRun
    cwd: string
    verifyCommandRunner?: PipelineIssueStateCommandRunner
  },
  command: string
): ReturnType<PipelineIssueStateCommandRunner> {
  if (input.verifyCommandRunner) {
    return input.verifyCommandRunner({
      command,
      cwd: input.cwd,
      timeoutSeconds: input.run.verifier?.timeoutSeconds ?? 60
    })
  }
  const result = await runDynamicContextCommand({
    command,
    cwd: input.cwd,
    timeoutMs: (input.run.verifier?.timeoutSeconds ?? 60) * 1000,
    maxStdoutChars: 32_000,
    maxStderrChars: 8_000
  })
  return { command, ...result }
}

function buildGitHubIssueStateCommand(run: PipelineRun, sourceId: string): string {
  if (run.taskSource.type !== 'github_issues') {
    throw new PipelineReviewMergeVerifyError(
      'missing_github_task_source',
      'GitHub issue closure gate requires a GitHub task source'
    )
  }
  return [
    'gh',
    'issue',
    'view',
    sourceId,
    '--repo',
    `${run.taskSource.owner}/${run.taskSource.repo}`,
    '--json',
    'state,url'
  ]
    .map(quoteShellArg)
    .join(' ')
}

function parseGitHubIssueState(stdout: string): { state: string; url: string | null } {
  const parsed = JSON.parse(stdout) as { state?: unknown; url?: unknown }
  if (typeof parsed.state !== 'string') {
    throw new Error('GitHub issue state lookup returned an invalid issue')
  }
  return {
    state: parsed.state,
    url: typeof parsed.url === 'string' ? parsed.url : null
  }
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=,+-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toPipelineError(error: PipelineReviewMergeVerifyError): {
  message: string
  code: string
  details: Record<string, unknown>
} {
  return { message: error.message, code: error.code, details: error.details }
}
