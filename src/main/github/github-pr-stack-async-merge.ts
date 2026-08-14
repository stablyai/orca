import type { GitHubPRMergeMethod } from '../../shared/github/pull-request-types'
import { ghExecFileAsync } from '../git/runner'
import { acquire, release } from './gh-utils'
import {
  githubHostExecOptions,
  type GitHubApiRepository,
  type GitHubRepoExecOptions
} from './github-api-repository'

const POLL_INTERVAL_MS = 1_000
const MAX_POLLS = 180

type AsyncMergeResponse = {
  status?: unknown
  details?: {
    message?: unknown
    uuid?: unknown
  }
}

type AsyncMergeResult =
  | { kind: 'pending'; uuid: string }
  | { kind: 'success' }
  | { kind: 'failure'; message: string }

export type GitHubPRStackMergeAction = 'direct_merge' | 'merge_queue'

function parseResponse(value: string): AsyncMergeResponse | null {
  try {
    return JSON.parse(value) as AsyncMergeResponse
  } catch {
    return null
  }
}

function errorResponseBody(error: unknown): AsyncMergeResponse | null {
  if (!error || typeof error !== 'object' || !('stdout' in error)) {
    return null
  }
  const stdout = (error as { stdout?: unknown }).stdout
  return parseResponse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout))
}

function classifyResult(response: AsyncMergeResponse): AsyncMergeResult {
  if (response.status === 'merged' || response.status === 'enqueued') {
    return { kind: 'success' }
  }
  if (response.status === 'pending' && typeof response.details?.uuid === 'string') {
    return { kind: 'pending', uuid: response.details.uuid }
  }
  const message =
    typeof response.details?.message === 'string'
      ? response.details.message
      : 'GitHub could not merge this stack.'
  return { kind: 'failure', message }
}

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
}

async function runStackMergeCommand(
  command: string[],
  options: NonNullable<Parameters<typeof ghExecFileAsync>[1]>
) {
  await acquire()
  try {
    return await ghExecFileAsync(command, options)
  } finally {
    release()
  }
}

export async function mergeGitHubPRStack(args: {
  repository: GitHubApiRepository
  prNumber: number
  method: GitHubPRMergeMethod
  mergeAction: GitHubPRStackMergeAction
  headSha?: string
  ghOptions: GitHubRepoExecOptions
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const endpoint = `repos/${args.repository.owner}/${args.repository.repo}/pulls/${args.prNumber}/merge-async`
  const command = ['api', '-X', 'PUT', endpoint, '-f', `merge_action=${args.mergeAction}`]
  if (args.mergeAction === 'direct_merge') {
    command.push('-f', `merge_method=${args.method}`)
  }
  if (args.headSha) {
    command.push('-f', `sha=${args.headSha}`)
  }

  let submitted: AsyncMergeResponse | null
  try {
    const { stdout } = await runStackMergeCommand(command, {
      ...args.ghOptions,
      ...githubHostExecOptions(args.repository),
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    submitted = parseResponse(stdout)
  } catch (error) {
    submitted = errorResponseBody(error)
    if (!submitted) {
      throw error
    }
  }
  if (!submitted) {
    return { ok: false, error: 'GitHub returned an invalid stack merge response.' }
  }
  let result = classifyResult(submitted)
  if (result.kind === 'success') {
    return { ok: true }
  }
  if (result.kind === 'failure') {
    return { ok: false, error: result.message }
  }

  const uuid = encodeURIComponent(result.uuid)
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await waitForNextPoll()
    let response: AsyncMergeResponse | null
    try {
      const { stdout } = await runStackMergeCommand(['api', `${endpoint}/${uuid}`], {
        ...args.ghOptions,
        ...githubHostExecOptions(args.repository)
      })
      response = parseResponse(stdout)
    } catch (error) {
      // Why: the merge was submitted; a transient poll failure cannot make it fail.
      response = errorResponseBody(error)
      if (!response) {
        continue
      }
    }
    if (!response) {
      return { ok: false, error: 'GitHub returned an invalid stack merge response.' }
    }
    result = classifyResult(response)
    if (result.kind === 'success') {
      return { ok: true }
    }
    if (result.kind === 'failure') {
      return { ok: false, error: result.message }
    }
  }
  return { ok: false, error: 'GitHub is still merging this stack. Refresh to check its status.' }
}
