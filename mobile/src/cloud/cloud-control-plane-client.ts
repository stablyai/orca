import { z } from 'zod'
import {
  CloudWorkspaceListResponseSchema,
  type CloudWorkspace as TeamWorkspace
} from '../../../src/shared/cloud-workspaces/cloud-workspaces-wire'
import {
  HostedWakeResponseSchema,
  HostedWorkspaceStatusResponseSchema,
  type HostedWakeResponse,
  type HostedWorkspaceStatus
} from '../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import {
  CloudRequestError,
  cloudRequest as request,
  type CloudControlPlane
} from './cloud-control-plane-request'

// The phone's direct HTTPS client for the Orca Cloud control plane. Every request carries a fresh
// device-signed token; the phone holds no bearer secret and no desktop sits in the path.

export type CloudWorkspaceStatus =
  | 'creating'
  | 'running'
  | 'waking'
  | 'stopping'
  | 'sleeping'
  | 'archived'
  | 'failed'

export type CloudWorkspace = {
  /** The sandbox row id: stable across sleep, wake and rollover. */
  id: string
  workspaceId: string
  title: string
  repo: { url: string; branch: string | null } | null
  status: CloudWorkspaceStatus
  machineSize: string
  createdAt: number
  lastActivityAt: number | null
  /** Compute spend so far, when the registry reports it. */
  cost: { usd: number; usdPerHour: number | null } | null
  createdByUserId: string | null
}
const SANDBOX_STATUS: Record<string, CloudWorkspaceStatus> = {
  creating: 'creating',
  running: 'running',
  ready: 'running',
  resuming: 'waking',
  waking: 'waking',
  suspending: 'stopping',
  stopping: 'stopping',
  suspended: 'sleeping',
  sleeping: 'sleeping',
  archived: 'archived',
  failed: 'failed',
  unresponsive: 'failed',
  destroying: 'stopping'
}

const SandboxViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  machineSize: z.string(),
  createdAt: z.number()
})

export function cloudWorkspaceTitleFallback(repoUrl: string | null, workspaceId: string): string {
  const name = repoUrl
    ?.replace(/\.git$/, '')
    .split('/')
    .findLast(Boolean)
  if (name) {
    return name
  }
  // Phone-made ids are `<repo>-<8 hex>`; other clients use opaque ids that read as noise.
  const named = /^(.+)-[0-9a-f]{8}$/.exec(workspaceId)?.[1]
  return named && !/^(m|orca)$/.test(named) && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(named)
    ? named
    : 'Cloud workspace'
}

function fromRegistry(row: TeamWorkspace): CloudWorkspace {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title?.trim() || cloudWorkspaceTitleFallback(row.repo?.url ?? null, row.workspaceId),
    repo: row.repo,
    status: row.archivedAt ? 'archived' : (SANDBOX_STATUS[row.status] ?? 'failed'),
    machineSize: row.machineSize,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    cost: {
      usd: row.cost.totalUsdMicros / 1_000_000,
      usdPerHour: row.cost.rateUsdMicrosPerHour ? row.cost.rateUsdMicrosPerHour / 1_000_000 : null
    },
    createdByUserId: row.createdBy
  }
}

function fromSandbox(row: z.infer<typeof SandboxViewSchema>): CloudWorkspace {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: cloudWorkspaceTitleFallback(null, row.workspaceId),
    repo: null,
    status: SANDBOX_STATUS[row.status] ?? 'failed',
    machineSize: row.machineSize,
    createdAt: row.createdAt,
    lastActivityAt: null,
    cost: null,
    createdByUserId: null
  }
}
// Lists archived rows as `archived` rather than folding them into `suspended` (W2 lifecycle).
const FEATURES = { 'x-orca-sandbox-features': 'archive' }

/** The team registry (titles, repos, cost) first; the owner-only lifecycle list until it ships. */
export async function listCloudWorkspaces(
  plane: CloudControlPlane,
  signal?: AbortSignal
): Promise<CloudWorkspace[]> {
  try {
    const body = await request(
      plane,
      'GET',
      '/v1/team/workspaces?scope=team&archived=include',
      CloudWorkspaceListResponseSchema,
      { signal }
    )
    return body.workspaces.map(fromRegistry)
  } catch (error) {
    if (!(error instanceof CloudRequestError) || error.status !== 404) {
      throw error
    }
  }
  const body = await request(
    plane,
    'GET',
    '/v1/sandboxes',
    z.object({ sandboxes: z.array(SandboxViewSchema) }),
    { signal, headers: FEATURES }
  )
  return body.sandboxes.map(fromSandbox)
}

export type CloudWakeState = HostedWakeResponse['state']

/** One long-poll wake (the server holds it up to 30 s); idempotent and single-flight server side. */
export async function wakeCloudWorkspace(
  plane: CloudControlPlane,
  sandboxId: string,
  signal?: AbortSignal
): Promise<{ state: CloudWakeState; endpoint: string | null }> {
  const body = await request(
    plane,
    'POST',
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/wake?wait=30s`,
    HostedWakeResponseSchema,
    { body: {}, timeoutMs: 45_000, signal }
  )
  return { state: body.state, endpoint: body.endpoint }
}

export async function sleepCloudWorkspace(
  plane: CloudControlPlane,
  sandboxId: string
): Promise<void> {
  await request(
    plane,
    'POST',
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/suspend`,
    z.unknown(),
    { timeoutMs: 60_000 }
  )
}

export async function archiveCloudWorkspace(
  plane: CloudControlPlane,
  sandboxId: string
): Promise<void> {
  await request(
    plane,
    'POST',
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/archive`,
    z.unknown(),
    { body: {}, timeoutMs: 90_000 }
  )
}

export type CloudWorkspaceLiveStatus = HostedWorkspaceStatus

/** Live state, uptime and spend. */
export async function readCloudWorkspaceStatus(
  plane: CloudControlPlane,
  sandboxId: string
): Promise<CloudWorkspaceLiveStatus> {
  const reply = await request(
    plane,
    'GET',
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/status`,
    HostedWorkspaceStatusResponseSchema
  )
  return reply.status
}

const ReadySchema = z.object({
  sandbox: SandboxViewSchema,
  connection: z.object({ projectRoot: z.string() }).passthrough()
})

export async function createCloudWorkspace(
  plane: CloudControlPlane,
  body: {
    workspaceId: string
    machineSize: 'standard' | 'large'
    repo?: { url: string; ref?: string }
  },
  signal?: AbortSignal
): Promise<{ workspace: CloudWorkspace; projectRoot: string }> {
  const ready = await request(plane, 'POST', '/v1/sandboxes', ReadySchema, {
    body,
    timeoutMs: 180_000,
    signal
  })
  const workspace = fromSandbox(ready.sandbox)
  return {
    workspace: {
      ...workspace,
      title: cloudWorkspaceTitleFallback(body.repo?.url ?? null, body.workspaceId),
      repo: body.repo ? { url: body.repo.url, branch: body.repo.ref ?? null } : null
    },
    projectRoot: ready.connection.projectRoot
  }
}

export async function renameCloudWorkspace(
  plane: CloudControlPlane,
  sandboxId: string,
  title: string
): Promise<void> {
  await request(
    plane,
    'PATCH',
    `/v1/team/workspaces/${encodeURIComponent(sandboxId)}`,
    z.unknown(),
    {
      body: { title }
    }
  ).catch(() => undefined)
}

export type CloudRole = 'owner' | 'admin' | 'member'

const MeSchema = z.object({ role: z.enum(['owner', 'admin', 'member']) }).passthrough()

/** This phone's team role (a personal account is its own owner); picks who an error sends you to. */
export async function readCloudRole(
  plane: CloudControlPlane,
  signal?: AbortSignal
): Promise<CloudRole> {
  // Short: the denial is already known and unknown falls back to member copy, so never hold it up.
  const me = await request(plane, 'GET', '/v1/me', MeSchema, { timeoutMs: 3_000, signal })
  return me.role
}
