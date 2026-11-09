// Private build only: the API operations behind `orca cloud …` (and `worktree create --on cloud`):
// selectors, create, message polling and flag readers. No Orca runtime involved.
import { homedir } from 'node:os'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { CloudApiClient, type CloudFetch } from './cloud-api-client'
import {
  nodeCloudCredentialFs,
  resolveCloudCredentials,
  type CloudCredentialEnv,
  type CloudCredentialFs
} from './cloud-credentials'
import type { CloudMessage, CloudProject, CloudWorkspace } from './cloud-format'

export type CloudHandlerDeps = {
  env: CloudCredentialEnv
  fetch: CloudFetch
  fs: CloudCredentialFs
  home: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Piped stdin (for `login` without --token); null when stdin is a terminal. */
  readStdin: () => Promise<string | null>
}

export const CLOUD_AGENTS = ['claude', 'codex'] as const
const WORKSPACE_ID = /^sbx_[A-Za-z0-9]+$/
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/
const SESSION_HANDLE = /^term_[A-Za-z0-9-]{1,80}$/
/** A create waits for the VM to boot; the control plane bounds that, this only stops a hang. */
export const CREATE_TIMEOUT_MS = 6 * 60_000
export const MUTATE_TIMEOUT_MS = 3 * 60_000
const MESSAGE_POLL_MS = 1500
export const DEFAULT_MESSAGE_WAIT_S = 180

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    if (chunks.reduce((n, c) => n + c.length, 0) > 16_384) {
      throw new RuntimeClientError('invalid_argument', 'The token on stdin is too long.')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const defaultCloudHandlerDeps = (): CloudHandlerDeps => ({
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  fs: nodeCloudCredentialFs,
  home: homedir(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readStdin: readPipedStdin
})

export function cloudClient(deps: CloudHandlerDeps): CloudApiClient {
  return new CloudApiClient(
    resolveCloudCredentials(deps.env, { fs: deps.fs, home: deps.home }),
    deps.fetch
  )
}

export function getAgentFlag(
  flags: Map<string, string | boolean>
): (typeof CLOUD_AGENTS)[number] | undefined {
  const agent = getOptionalStringFlag(flags, 'agent')
  if (agent === undefined) {
    return undefined
  }
  if (!(CLOUD_AGENTS as readonly string[]).includes(agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--agent must be one of: ${CLOUD_AGENTS.join(', ')}`,
      {
        field: 'agent'
      }
    )
  }
  return agent as (typeof CLOUD_AGENTS)[number]
}

/**
 * `sbx_…` ids pass through; `self` is the workspace this token was minted for (inside a VM);
 * anything else is matched against workspace names this token can see.
 */
export async function resolveCloudWorkspaceId(
  api: CloudApiClient,
  selector: string
): Promise<string> {
  if (WORKSPACE_ID.test(selector)) {
    return selector
  }
  if (selector === 'self') {
    if (!api.credentials.workspaceId) {
      throw new RuntimeClientError(
        'invalid_argument',
        '"self" works only inside an Orca Cloud workspace (its credentials name the workspace).'
      )
    }
    return api.credentials.workspaceId
  }
  const { workspaces } = await api.request<{ workspaces: CloudWorkspace[] }>(
    'GET',
    '/v1/workspaces',
    {
      query: { include: 'archived' }
    }
  )
  const matches = workspaces.filter((w) => w.name === selector)
  if (matches.length === 1) {
    return matches[0].id
  }
  if (matches.length === 0) {
    throw new RuntimeClientError('cloud_not_found', `No workspace named "${selector}".`, {
      nextSteps: ['Run `orca cloud workspace list` and pass the workspace id (sbx_…).']
    })
  }
  throw new RuntimeClientError(
    'selector_ambiguous',
    `${matches.length} workspaces are named "${selector}"; pass the id instead.`,
    { choices: matches.map((w) => ({ id: w.id, status: w.status, createdAt: w.createdAt })) }
  )
}

export async function resolveCloudProjectId(
  api: CloudApiClient,
  selector: string
): Promise<string> {
  if (PROJECT_ID.test(selector)) {
    return selector
  }
  const { projects } = await api.request<{ projects: CloudProject[] }>('GET', '/v1/projects')
  const match = projects.find((p) => p.name === selector)
  if (!match) {
    throw new RuntimeClientError('cloud_not_found', `No project named "${selector}".`, {
      nextSteps: ['Run `orca cloud projects list`.']
    })
  }
  return match.id
}

export type CloudWorkspaceCreateInput = {
  name?: string
  projectId?: string
  repo?: { url: string; ref?: string }
  machineSize?: 'standard' | 'large'
  region?: string
  message?: { text: string; agent?: (typeof CLOUD_AGENTS)[number] }
}

export async function createCloudWorkspace(
  api: CloudApiClient,
  input: CloudWorkspaceCreateInput,
  now: () => number
): Promise<{ workspace: CloudWorkspace; message?: CloudMessage; elapsedMs: number }> {
  const started = now()
  const created = await api.request<{ workspace: CloudWorkspace; message?: CloudMessage }>(
    'POST',
    '/v1/workspaces',
    { body: input, timeoutMs: CREATE_TIMEOUT_MS }
  )
  return { ...created, elapsedMs: now() - started }
}

/** Repo URLs the control plane accepts: https only. `git@host:owner/repo` is rewritten. */
export function normalizeCloudRepoUrl(raw: string): string {
  const value = raw.trim()
  const scp = /^[\w.-]+@([\w.-]+):(.+?)$/.exec(value)
  const candidate = scp
    ? `https://${scp[1]}/${scp[2]}`
    : value.replace(/^ssh:\/\/[\w.-]+@/, 'https://')
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new RuntimeClientError('invalid_argument', `--repo must be an https:// git URL: ${raw}`, {
      field: 'repo'
    })
  }
  if (url.protocol !== 'https:') {
    throw new RuntimeClientError('invalid_argument', `--repo must be an https:// git URL: ${raw}`, {
      field: 'repo'
    })
  }
  // Credentials in a URL would be stored server-side; private repos use the GitHub connection.
  url.username = ''
  url.password = ''
  return url.toString()
}

export function getSizeFlag(
  flags: Map<string, string | boolean>
): 'standard' | 'large' | undefined {
  const size = getOptionalStringFlag(flags, 'size')
  if (size === undefined || size === 'standard' || size === 'large') {
    return size
  }
  throw new RuntimeClientError('invalid_argument', '--size must be standard or large', {
    field: 'size'
  })
}

/** Reads `--text` (required) / `--agent` / `--session` for `cloud message`. */
export function readMessageFlags(flags: Map<string, string | boolean>) {
  const text = getRequiredStringFlag(flags, 'text')
  const agent = getAgentFlag(flags)
  const session = getOptionalStringFlag(flags, 'session')
  if (session !== undefined && !SESSION_HANDLE.test(session)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--session must be a session handle (term_…) from `orca cloud sessions` or a previous message.',
      { field: 'session' }
    )
  }
  return { text, ...(agent ? { agent } : {}), ...(session ? { session } : {}) }
}

export async function waitForCloudMessage(
  api: CloudApiClient,
  deps: Pick<CloudHandlerDeps, 'now' | 'sleep'>,
  message: CloudMessage,
  timeoutMs: number
): Promise<CloudMessage> {
  const deadline = deps.now() + timeoutMs
  let current = message
  while (current.status === 'queued' || current.status === 'delivering') {
    if (deps.now() >= deadline) {
      throw new RuntimeClientError(
        'cloud_message_timeout',
        `Message ${current.id} is still ${current.status} after ${Math.round(timeoutMs / 1000)}s (the workspace may be waking).`,
        {
          message: current,
          nextSteps: [`Check later: orca cloud message status ${current.workspaceId} ${current.id}`]
        }
      )
    }
    await deps.sleep(MESSAGE_POLL_MS)
    current = (
      await api.request<{ message: CloudMessage }>(
        'GET',
        `/v1/workspaces/${encodeURIComponent(current.workspaceId)}/messages/${encodeURIComponent(current.id)}`
      )
    ).message
  }
  if (current.status === 'failed') {
    throw new RuntimeClientError(
      'cloud_message_failed',
      `Message ${current.id} could not be delivered: ${current.error ?? 'unknown error'}.`,
      { message: current }
    )
  }
  return current
}

export function workspacePath(id: string, sub = ''): string {
  return `/v1/workspaces/${encodeURIComponent(id)}${sub}`
}
