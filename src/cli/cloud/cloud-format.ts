// Private build only: text output for `orca cloud …`. JSON output is the API view wrapped as
// { ok, schemaVersion, result } (see printCloudResult).

export const CLOUD_CLI_SCHEMA_VERSION = 1

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

function ago(at: number | null | undefined, now: number): string {
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

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

export function formatCloudWorkspaceList(
  value: { workspaces: CloudWorkspace[] },
  now = Date.now()
): string {
  if (value.workspaces.length === 0) {
    return 'No workspaces.'
  }
  return table(
    ['ID', 'NAME', 'STATUS', 'ORIGIN', 'CREATED'],
    value.workspaces.map((w) => [
      w.id,
      w.name,
      w.archived ? `${w.status} (archived)` : w.status,
      w.origin,
      ago(w.createdAt, now)
    ])
  )
}

export function formatCloudWorkspace(
  value: { workspace: CloudWorkspace; message?: CloudMessage; elapsedMs?: number },
  now = Date.now()
): string {
  const w = value.workspace
  const lines = [
    `${w.name} (${w.id})`,
    `status: ${w.status}${w.archived ? ' (archived)' : ''}`,
    `origin: ${w.origin}`,
    `size: ${w.machineSize}${w.region ? ` in ${w.region}` : ''}`,
    ...(w.repoUrl ? [`repo: ${w.repoUrl}`] : []),
    ...(w.projectId ? [`project: ${w.projectId}`] : []),
    ...(w.session
      ? [`session lease expires: ${new Date(w.session.leaseExpiresAt).toISOString()}`]
      : []),
    ...(w.lastError ? [`last error: ${w.lastError}`] : []),
    `created: ${ago(w.createdAt, now)}`
  ]
  if (value.message) {
    lines.push(`message: ${value.message.id} (${value.message.status}, ${value.message.agent})`)
  }
  if (value.elapsedMs !== undefined) {
    lines.push(`took ${(value.elapsedMs / 1000).toFixed(1)}s`)
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

export function formatCloudSessions(
  value: { workspaceStatus: string; sessions: CloudSession[] },
  now = Date.now()
): string {
  if (value.sessions.length === 0) {
    return value.workspaceStatus === 'running'
      ? 'No agent sessions.'
      : `No agent sessions (workspace is ${value.workspaceStatus}; wake it to see live sessions).`
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
    ['ID', 'NAME', 'REPO', 'SIZE'],
    value.projects.map((p) => [
      p.id,
      p.name,
      p.repo ? `${p.repo.url}${p.repo.ref ? `#${p.repo.ref}` : ''}` : '-',
      p.environment.machineSize
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
    ...(me.orgId ? [`org: ${me.orgId} (${me.role})`] : [`role: ${me.role}`]),
    `via: ${me.via} (${value.tokenKind} from ${value.credentialSource})`,
    ...(me.workspaceId ? [`workspace: ${me.workspaceId}`] : []),
    `scopes: ${me.scopes.join(', ') || '-'}`,
    `api: ${value.apiUrl}`
  ].join('\n')
}
