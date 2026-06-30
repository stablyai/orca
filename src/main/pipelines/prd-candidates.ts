import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PipelineDb } from './db'
import { derivePipelinePrdLabel } from '../../shared/pipeline-prd-work-set'
import type { PipelinePrdCandidate } from '../../shared/pipelines-types'

const execFileAsync = promisify(execFile)

export type PipelineGitHubCommandRunner = (input: { args: string[] }) => Promise<string>

export async function runGitHubCli(input: { args: string[] }): Promise<string> {
  const { stdout } = await execFileAsync('gh', input.args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

export async function listPipelinePrdCandidates(input: {
  db: PipelineDb
  githubCommandRunner: PipelineGitHubCommandRunner
  repoId: string
  owner: string
  repo: string
  limit?: number
}): Promise<PipelinePrdCandidate[]> {
  const repoSelector = `${input.owner}/${input.repo}`
  const prdIssues = parseGitHubCandidateIssues(
    await input.githubCommandRunner({
      args: [
        'issue',
        'list',
        '--repo',
        repoSelector,
        '--state',
        'open',
        '--label',
        'prd',
        '--limit',
        String(input.limit ?? 20),
        '--json',
        'number,title,state,updatedAt'
      ]
    })
  )
  const candidates: PipelinePrdCandidate[] = []
  for (const prd of prdIssues) {
    candidates.push(await buildCandidate(input, repoSelector, prd))
  }
  return candidates
}

async function buildCandidate(
  input: {
    db: PipelineDb
    githubCommandRunner: PipelineGitHubCommandRunner
    repoId: string
    owner: string
    repo: string
  },
  repoSelector: string,
  prd: GitHubCandidateIssue
): Promise<PipelinePrdCandidate> {
  const pipelinePrdLabel = derivePipelinePrdLabel(prd.number)
  const taskIssues = parseGitHubCandidateIssues(
    await input.githubCommandRunner({
      args: [
        'issue',
        'list',
        '--repo',
        repoSelector,
        '--state',
        'open',
        '--label',
        'task-slice',
        '--label',
        pipelinePrdLabel,
        '--limit',
        '100',
        '--json',
        'number,title,body,state,updatedAt,labels'
      ]
    })
  ).filter((issue) => issueBodyReferencesPrd(issue.body, prd.number))
  const readyTasks = taskIssues.filter((issue) => issue.labels.includes('ready-for-agent'))
  const reservation = input.db.getActiveRunReservation({
    repoId: input.repoId,
    providerOwner: input.owner,
    providerRepo: input.repo,
    prdIssueNumber: prd.number,
    pipelinePrdLabel
  })
  return {
    provider: 'github',
    owner: input.owner,
    repo: input.repo,
    prdIssueNumber: prd.number,
    prdTitle: prd.title,
    pipelinePrdLabel,
    readyTaskCount: readyTasks.length,
    openTaskCount: taskIssues.length,
    latestTaskUpdatedAt: latestUpdatedAt(taskIssues, prd.updatedAt),
    latestPrdUpdatedAt: prd.updatedAt,
    activeRunId: reservation?.runId,
    reservationId: reservation?.id
  }
}

type GitHubCandidateIssue = {
  number: number
  title: string
  body: string
  updatedAt: string
  labels: string[]
}

function parseGitHubCandidateIssues(stdout: string): GitHubCandidateIssue[] {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub issue candidate lookup must return an array')
  }
  return parsed.map((item) => {
    const issue = item as {
      number?: unknown
      title?: unknown
      body?: unknown
      updatedAt?: unknown
      labels?: unknown
    }
    if (typeof issue.number !== 'number' || typeof issue.title !== 'string') {
      throw new Error('GitHub issue candidate lookup returned an invalid issue')
    }
    return {
      number: issue.number,
      title: issue.title,
      body: typeof issue.body === 'string' ? issue.body : '',
      updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
      labels: parseGitHubLabels(issue.labels)
    }
  })
}

function parseGitHubLabels(labels: unknown): string[] {
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

function issueBodyReferencesPrd(body: string, prdIssueNumber: number): boolean {
  const escapedNumber = String(prdIssueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bPRD issue:\\s*#${escapedNumber}\\b`, 'i').test(body)
}

function latestUpdatedAt(issues: GitHubCandidateIssue[], fallback: string): string {
  return issues.reduce(
    (latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest),
    fallback
  )
}
