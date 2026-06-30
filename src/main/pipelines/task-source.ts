import type { PipelineTaskRecordSourceType, PipelineTaskSource } from '../../shared/pipelines-types'
import {
  derivePipelinePrdLabel,
  validatePipelinePrdLabel
} from '../../shared/pipeline-prd-work-set'

export type PipelineSourceTask = {
  sourceType: PipelineTaskRecordSourceType
  sourceId: string
  title: string
  body: string
  url: string | null
  labels: string[]
}

export type PipelineTaskSourceCommandRunner = (input: { command: string }) => Promise<string>

export type ResolvePipelineTaskSourceInput = {
  taskSource: PipelineTaskSource
  commandRunner: PipelineTaskSourceCommandRunner
}

export type ResolvedPipelineTaskSource = {
  tasks: PipelineSourceTask[]
  listTasksCommand: string
  viewTaskCommand: (sourceId: string) => string
  closeTaskCommand: (sourceId: string) => string
}

type GitHubIssueListItem = {
  number?: unknown
  title?: unknown
  body?: unknown
  state?: unknown
  url?: unknown
  labels?: unknown
}

type GitHubIssueViewItem = {
  number?: unknown
  title?: unknown
  state?: unknown
  url?: unknown
}

export async function resolvePipelineTaskSource(
  input: ResolvePipelineTaskSourceInput
): Promise<ResolvedPipelineTaskSource> {
  if (input.taskSource.type === 'manual') {
    return resolveManualTaskSource(input.taskSource.tasks)
  }

  return resolveGitHubIssueTaskSource(input)
}

function resolveManualTaskSource(
  tasks: Extract<PipelineTaskSource, { type: 'manual' }>['tasks']
): ResolvedPipelineTaskSource {
  return {
    tasks: tasks.map((task) => ({
      sourceType: 'manual',
      sourceId: task.id,
      title: task.title,
      body: task.body,
      url: null,
      labels: []
    })),
    listTasksCommand: 'pipeline:manual:list',
    viewTaskCommand: (sourceId) => `pipeline:manual:view ${sourceId}`,
    closeTaskCommand: (sourceId) => `pipeline:manual:close ${sourceId}`
  }
}

async function resolveGitHubIssueTaskSource(
  input: ResolvePipelineTaskSourceInput
): Promise<ResolvedPipelineTaskSource> {
  const taskSource = input.taskSource
  if (taskSource.type !== 'github_issues') {
    throw new Error(`Unsupported pipeline task source: ${taskSource.type}`)
  }

  validatePipelinePrdLabel(taskSource.prdIssueNumber, taskSource.pipelinePrdLabel)
  const repo = `${taskSource.owner}/${taskSource.repo}`
  const prdCommand = buildGitHubIssueViewCommand(repo, taskSource.prdIssueNumber)
  const prd = parseGitHubIssueView(await input.commandRunner({ command: prdCommand }))
  if (normalizeGitHubState(prd.state) !== 'open') {
    throw new Error(`Pipeline PRD issue #${taskSource.prdIssueNumber} must be open`)
  }

  const listTasksCommand = buildGitHubIssueListCommand({
    repo,
    state: taskSource.state,
    labels: ['task-slice', 'ready-for-agent', taskSource.pipelinePrdLabel]
  })
  const stdout = await input.commandRunner({ command: listTasksCommand })
  const issues = parseGitHubIssueList(stdout)
  const tasks = issues
    .filter((issue) =>
      isRunnablePipelineTaskIssue({
        issue,
        prdIssueNumber: taskSource.prdIssueNumber,
        pipelinePrdLabel: taskSource.pipelinePrdLabel
      })
    )
    .map((issue) => ({
      sourceType: 'github_issue' as const,
      sourceId: String(issue.number),
      title: issue.title,
      body: issue.body,
      url: issue.url,
      labels: issue.labels
    }))

  return {
    tasks,
    listTasksCommand,
    viewTaskCommand: (sourceId) =>
      `gh issue view ${quoteShellArg(sourceId)} --repo ${quoteShellArg(repo)} --comments`,
    closeTaskCommand: (sourceId) =>
      `gh issue close ${quoteShellArg(sourceId)} --repo ${quoteShellArg(repo)}`
  }
}

export { derivePipelinePrdLabel, validatePipelinePrdLabel }

function buildGitHubIssueViewCommand(repo: string, issueNumber: number): string {
  return [
    'gh',
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    repo,
    '--json',
    'number,title,state,url'
  ]
    .map(quoteShellArg)
    .join(' ')
}

function buildGitHubIssueListCommand(input: {
  repo: string
  state: string
  labels: string[]
}): string {
  const args = [
    'gh',
    'issue',
    'list',
    '--repo',
    input.repo,
    '--state',
    input.state,
    '--limit',
    '100'
  ]

  for (const label of input.labels) {
    args.push('--label', label)
  }

  args.push('--json', 'number,title,body,state,url,labels')
  return args.map(quoteShellArg).join(' ')
}

function parseGitHubIssueView(stdout: string): {
  number: number
  title: string
  state: string
  url: string | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('GitHub PRD issue lookup returned invalid JSON')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('GitHub PRD issue lookup must return a JSON object')
  }
  const issue = parsed as GitHubIssueViewItem
  if (typeof issue.number !== 'number' || typeof issue.title !== 'string') {
    throw new Error('GitHub PRD issue lookup returned an invalid issue record')
  }
  return {
    number: issue.number,
    title: issue.title,
    state: typeof issue.state === 'string' ? issue.state : '',
    url: typeof issue.url === 'string' ? issue.url : null
  }
}

function parseGitHubIssueList(stdout: string): {
  number: number
  title: string
  body: string
  url: string | null
  labels: string[]
  state: string
}[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('GitHub issue task source returned invalid JSON')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('GitHub issue task source must return a JSON array')
  }

  return parsed.map(normalizeGitHubIssueListItem)
}

function normalizeGitHubIssueListItem(issue: GitHubIssueListItem): {
  number: number
  title: string
  body: string
  url: string | null
  labels: string[]
  state: string
} {
  if (typeof issue.number !== 'number' || typeof issue.title !== 'string') {
    throw new Error('GitHub issue task source returned an invalid issue record')
  }

  return {
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === 'string' ? issue.body : '',
    url: typeof issue.url === 'string' ? issue.url : null,
    labels: normalizeGitHubLabels(issue.labels),
    state: typeof issue.state === 'string' ? issue.state : ''
  }
}

function isRunnablePipelineTaskIssue(input: {
  issue: {
    number: number
    body: string
    labels: string[]
    state: string
  }
  prdIssueNumber: number
  pipelinePrdLabel: string
}): boolean {
  const labels = new Set(input.issue.labels)
  return (
    normalizeGitHubState(input.issue.state) === 'open' &&
    labels.has('task-slice') &&
    labels.has('ready-for-agent') &&
    labels.has(input.pipelinePrdLabel) &&
    issueBodyReferencesPrd(input.issue.body, input.prdIssueNumber)
  )
}

function issueBodyReferencesPrd(body: string, prdIssueNumber: number): boolean {
  const escapedNumber = String(prdIssueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bPRD issue:\\s*#${escapedNumber}\\b`, 'i').test(body)
}

function normalizeGitHubState(state: string): 'open' | 'closed' | 'unknown' {
  const normalized = state.toLowerCase()
  if (normalized === 'open') {
    return 'open'
  }
  if (normalized === 'closed') {
    return 'closed'
  }
  return 'unknown'
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return []
  }

  return labels.flatMap((label) => {
    if (typeof label === 'string') {
      return [label]
    }
    if (
      label &&
      typeof label === 'object' &&
      typeof (label as { name?: unknown }).name === 'string'
    ) {
      return [(label as { name: string }).name]
    }
    return []
  })
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=,+-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}
