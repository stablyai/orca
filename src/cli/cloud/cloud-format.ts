// Private build only: text output for `orca cloud …`. JSON output is the API view wrapped as
// { ok, schemaVersion, result } (see printCloudResult). Human output follows the product glossary:
// states and problems in words; raw API statuses and codes appear only under --json.
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../shared/hosted-sandbox/hosted-sandbox-wire'

const CLOUD_CLI_SCHEMA_VERSION = 1

export type CloudWorkspace = {
  id: string
  name: string
  projectId: string | null
  status: string
  archived: boolean
  hidden: boolean
  origin: string
  machineSize: string
  region: string | null
  repoUrl: string | null
  /** Older control planes omit these two. */
  repoBranch?: string | null
  lastActivityAt?: number | null
  session: { startedAt: number; leaseExpiresAt: number; deadlineAt: number | null } | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type CloudProject = {
  id: string
  name: string
  repo: { url: string; ref: string | null } | null
  environment: { machineSize: string; region: string | null; buildId: string | null }
  createdAt: number
}

export type CloudMessage = {
  id: string
  workspaceId: string
  agent: string
  status: 'queued' | 'delivering' | 'delivered' | 'failed'
  session: string | null
  error: string | null
  attempts: number
  createdAt: number
  deliveredAt: number | null
}

export type CloudSession = {
  handle: string
  agent: string | null
  title: string | null
  connected: boolean
  lastOutputAt: number | null
  preview: string | null
}

export type CloudMe = {
  accountId: string
  userId: string
  orgId: string | null
  role: string
  via: string
  scopes: string[]
  workspaceId?: string
}

export function printCloudResult<T>(result: T, json: boolean, format: (value: T) => string): void {
  if (json) {
    console.log(
      JSON.stringify({ ok: true, schemaVersion: CLOUD_CLI_SCHEMA_VERSION, result }, null, 2)
    )
    return
  }
  console.log(format(result))
}

export function ago(at: number | null | undefined, now: number): string {
  if (!at) {
    return '-'
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`
  }
  return `${Math.round(seconds / 86_400)}d ago`
}

/** "42s", "1m 42s", "1h 5m" (the desktop's formatElapsedTime style). */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

/** "Sandbox size: 8 vCPU · 16 GB". There is one size; it always comes from ORCA_CLOUD_SANDBOX_SPEC. */
export const CLOUD_SANDBOX_SIZE_LINE = `Sandbox size: ${ORCA_CLOUD_SANDBOX_SPEC.vcpus} vCPU · ${ORCA_CLOUD_SANDBOX_SPEC.memoryGb} GB`

/**
 * The API's workspace status in glossary words (Starting, Running, Asleep, Waking, …). A failed
 * wake leaves the workspace asleep with lastError resume_failed: that is "Couldn't wake".
 */
export function cloudWorkspaceStateLabel(
  w: Pick<CloudWorkspace, 'status' | 'archived'> & { lastError?: string | null }
): string {
  switch (w.status) {
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'sleeping':
      if (w.archived) {
        return 'Archived'
      }
      return w.lastError === 'resume_failed' ? "Couldn't wake" : 'Asleep'
    case 'waking':
      return 'Waking'
    case 'destroying':
      return 'Deleting'
    case 'destroyed':
      return 'Deleted'
    case 'failed':
      return "Couldn't start"
    default:
      return w.archived ? 'Archived' : 'Unknown'
  }
}

/** `https://github.com/acme/app(.git)` → `acme/app`; other hosts keep the full URL. */
function shortRepo(url: string | null): string {
  if (!url) {
    return '-'
  }
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  return github ? github[1] : url
}

function lastActive(w: CloudWorkspace): number {
  return w.lastActivityAt ?? w.updatedAt
}

export function formatCloudWorkspaceList(
  value: { workspaces: CloudWorkspace[] },
  now = Date.now()
): string {
  if (value.workspaces.length === 0) {
    return 'No cloud workspaces yet. Create one with: orca cloud workspace create'
  }
  return table(
    ['ID', 'NAME', 'STATE', 'REPO', 'BRANCH', 'LAST ACTIVE'],
    value.workspaces.map((w) => [
      w.id,
      w.name,
      cloudWorkspaceStateLabel(w),
      shortRepo(w.repoUrl),
      w.repoBranch || '-',
      ago(lastActive(w), now)
    ])
  )
}

const ORIGIN_LABELS: Record<string, string> = {
  desktop: 'the Orca app',
  api: 'the Orca Cloud API',
  mcp: 'an MCP client',
  routine: 'a routine',
  vm: 'another cloud workspace'
}

/** One plain sentence for the workspace's last problem, or null when there is nothing to say. */
function workspaceProblem(w: CloudWorkspace): string | null {
  if (w.status === 'failed') {
    return `This workspace couldn't start. Delete it and create a new one: orca cloud workspace delete ${w.id}`
  }
  if (w.status === 'sleeping' && w.lastError === 'resume_failed') {
    return `The last wake didn't finish. Your files are safe. Run: orca cloud workspace wake ${w.id}`
  }
  return null
}

export function formatCloudWorkspace(
  value: { workspace: CloudWorkspace; message?: CloudMessage; elapsedMs?: number },
  now = Date.now()
): string {
  const w = value.workspace
  const problem = workspaceProblem(w)
  const origin = ORIGIN_LABELS[w.origin]
  const lines = [
    `${w.name} (${w.id})`,
    `State: ${cloudWorkspaceStateLabel(w)}`,
    ...(problem ? [problem] : []),
    CLOUD_SANDBOX_SIZE_LINE,
    ...(w.repoUrl ? [`Repo: ${w.repoUrl}${w.repoBranch ? ` (${w.repoBranch})` : ''}`] : []),
    ...(w.projectId ? [`Project: ${w.projectId}`] : []),
    ...(origin ? [`Created from: ${origin}`] : []),
    `Last active: ${ago(lastActive(w), now)}`,
    `Created: ${ago(w.createdAt, now)}`
  ]
  if (value.message) {
    lines.push(
      `First message: ${value.message.status} for ${value.message.agent} (${value.message.id})`
    )
  }
  if (value.elapsedMs !== undefined) {
    lines.push(`Took ${formatElapsed(value.elapsedMs)}`)
  }
  return lines.join('\n')
}

export function formatCloudMessage(value: { message: CloudMessage; waitedMs?: number }): string {
  const m = value.message
  return [
    `message ${m.id}: ${m.status}`,
    `agent: ${m.agent}`,
    ...(m.session ? [`session: ${m.session}  (continue with --session ${m.session})`] : []),
    ...(m.error ? [`error: ${m.error}`] : []),
    ...(value.waitedMs !== undefined ? [`waited ${(value.waitedMs / 1000).toFixed(1)}s`] : [])
  ].join('\n')
}

export function formatCloudMessageList(value: { messages: CloudMessage[] }): string {
  if (value.messages.length === 0) {
    return 'No messages.'
  }
  return value.messages
    .map(
      (m) =>
        `${m.id}  ${m.status}  ${m.agent}${m.session ? `  ${m.session}` : ''}${m.error ? `  error: ${m.error}` : ''}`
    )
    .join('\n')
}

export function formatCloudSessions(
  value: { workspaceStatus: string; sessions: CloudSession[] },
  now = Date.now()
): string {
  if (value.sessions.length === 0) {
    return value.workspaceStatus === 'running'
      ? 'No agent sessions.'
      : `No agent sessions. The workspace is ${cloudWorkspaceStateLabel({ status: value.workspaceStatus, archived: false }).toLowerCase()}; wake it to see live sessions.`
  }
  return value.sessions
    .map((s) =>
      [
        `${s.handle}  ${s.agent ?? 'terminal'}  ${s.connected ? 'connected' : 'disconnected'}  last output ${ago(s.lastOutputAt, now)}${s.title ? `  ${s.title}` : ''}`,
        ...(s.preview ? s.preview.split('\n').map((line) => `    ${line}`) : [])
      ].join('\n')
    )
    .join('\n')
}

export function formatCloudProjects(value: { projects: CloudProject[] }): string {
  if (value.projects.length === 0) {
    return 'No projects.'
  }
  return table(
    ['ID', 'NAME', 'REPO'],
    value.projects.map((p) => [
      p.id,
      p.name,
      p.repo ? `${p.repo.url}${p.repo.ref ? `#${p.repo.ref}` : ''}` : '-'
    ])
  )
}

export function formatCloudWhoami(value: {
  me: CloudMe
  apiUrl: string
  credentialSource: string
  tokenKind: string
}): string {
  const me = value.me
  return [
    `account: ${me.accountId}`,
    `user: ${me.userId}`,
    ...(me.orgId ? [`team: ${me.orgId} (${me.role})`] : [`role: ${me.role}`]),
    `via: ${me.via} (${value.tokenKind} from ${value.credentialSource})`,
    ...(me.workspaceId ? [`workspace: ${me.workspaceId}`] : []),
    `scopes: ${me.scopes.join(', ') || '-'}`,
    `api: ${value.apiUrl}`
  ].join('\n')
}
