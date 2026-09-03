import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { relayRepositoryApiPath } from './relay-repository.js'

const execFileAsync = promisify(execFile)

const WorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string()
})

const WorkflowRunsSchema = z.object({
  workflow_runs: z.array(WorkflowRunSchema)
})

export type RelayWorkflowRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  headSha: string
  url: string
  createdAt: string
  updatedAt: string
}

const RELAY_WORKFLOW_PATTERN = /(Relay|Auth|Power)/i

export async function readRelayWorkflowRuns(): Promise<RelayWorkflowRun[]> {
  let stdout: string
  try {
    const result = await execFileAsync(
      'gh',
      [
        'api',
        '--method',
        'GET',
        relayRepositoryApiPath('actions/runs'),
        '-f',
        'per_page=100'
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    )
    stdout = result.stdout
  } catch {
    throw new Error('GitHub workflow history is unavailable')
  }
  const runs = WorkflowRunsSchema.parse(JSON.parse(stdout) as unknown).workflow_runs
  const counts = new Map<string, number>()
  return runs
    .filter((run) => {
      if (!RELAY_WORKFLOW_PATTERN.test(run.name)) return false
      const count = counts.get(run.name) ?? 0
      if (count >= 2) return false
      counts.set(run.name, count + 1)
      return true
    })
    .slice(0, 12)
    .map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.head_sha.slice(0, 8),
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    }))
}
