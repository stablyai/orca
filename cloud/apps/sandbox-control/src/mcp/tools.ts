// MCP tools: each one is a thin, typed front for one public API route. A tool call is dispatched to
// the same handler the REST API uses (src/api/router.ts handleApiAs) with the MCP caller, so scopes,
// validation, audit entries and rate limits are exactly the REST ones — nothing is reimplemented here.
import { z } from 'zod'
import { AGENTS } from '../api/vm-agent'

/** Calls the public API as the MCP caller. Path is relative to the API origin (`/v1/...`). */
export type ApiCall = (method: string, path: string, body?: unknown) => Promise<Response>

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

type ToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: boolean
}

type ToolDef<T extends z.ZodObject> = {
  name: string
  description: string
  input: T
  annotations: ToolAnnotations
  run: (args: z.infer<T>, api: ApiCall) => Promise<ToolResult>
}

// Ids go into URL paths: restrict them so a tool argument can never address another route.
const Id = (what: string) => z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, `a ${what} id`).describe(`The ${what} id.`)
const WorkspaceId = z.object({ workspaceId: Id('workspace') }).strict()
const Agent = z.enum(AGENTS).describe('Agent CLI to run: claude (Claude Code, default) or codex.')
const MAX_WAIT_SECONDS = 45

function ok(body: unknown): ToolResult {
  const structured = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : { result: body }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: structured }
}

export function toolError(message: string, detail?: Record<string, unknown>): ToolResult {
  const body = { error: message, ...detail }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
}

const HINTS: Record<string, string> = {
  unauthorized: 'The credential is no longer valid; reconnect the Orca Cloud MCP server.',
  insufficient_scope: 'This connection was not granted the scope this tool needs; reconnect and approve it.',
  not_found: 'No such resource in this Orca account (check the id with list_workspaces / list_projects).',
  rate_limited: 'Too many requests; wait a minute and retry.',
  conflict: 'The workspace is busy with another lifecycle change or in the wrong state; check get_workspace and retry.',
  entitlement_denied: 'The account plan does not allow this (concurrency or usage limit).',
  workspace_unavailable: 'The workspace VM did not answer; check get_workspace (it may be sleeping or starting).',
  not_configured: 'Orca Cloud workspaces are not available on this server.'
}

/** API response -> tool result. Non-2xx answers become tool errors the model can read and act on. */
async function fromApi(response: Response): Promise<ToolResult> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  if (response.ok) {
    return ok(body)
  }
  const error = (body as { error?: string; reason?: string } | null) ?? {}
  const code = error.error ?? `http_${response.status}`
  return toolError(code, {
    status: response.status,
    ...(error.reason ? { reason: error.reason } : {}),
    ...(HINTS[code] ? { hint: HINTS[code] } : {}),
    ...(response.headers.get('retry-after') ? { retryAfterSeconds: Number(response.headers.get('retry-after')) } : {})
  })
}

function tool<T extends z.ZodObject>(def: ToolDef<T>): ToolDef<T> {
  return def
}

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, openWorldHint: false })

export const TOOLS = [
  tool({
    name: 'whoami',
    description: 'Shows which Orca account and user this connection acts as, and the scopes it was granted. Call this first if a tool reports insufficient_scope.',
    input: z.object({}).strict(),
    annotations: read('Who am I'),
    run: async (_args, api) => fromApi(await api('GET', '/v1/me'))
  }),
  tool({
    name: 'list_projects',
    description: 'Lists the Orca Cloud projects in this account. A project is a repository plus default machine settings; pass its id to create_workspace to start a workspace from it.',
    input: z.object({}).strict(),
    annotations: read('List projects'),
    run: async (_args, api) => fromApi(await api('GET', '/v1/projects'))
  }),
  tool({
    name: 'list_workspaces',
    description:
      'Lists Orca Cloud workspaces (cloud VMs with a checked-out repo and coding agents). Each has an id, name, status (starting, running, sleeping, stopped, failed, destroyed), project and repo. Archived and hidden (routine run) workspaces are left out unless requested.',
    input: z
      .object({
        projectId: Id('project').optional().describe('Only workspaces started from this project.'),
        includeArchived: z.boolean().optional().describe('Also list archived workspaces.'),
        includeHidden: z.boolean().optional().describe('Also list hidden workspaces made by routine runs.')
      })
      .strict(),
    annotations: read('List workspaces'),
    run: async (args, api) => {
      const query = new URLSearchParams()
      const include = [args.includeArchived ? 'archived' : '', args.includeHidden ? 'hidden' : ''].filter(Boolean)
      if (include.length) query.set('include', include.join(','))
      if (args.projectId) query.set('projectId', args.projectId)
      return fromApi(await api('GET', `/v1/workspaces${query.size ? `?${query}` : ''}`))
    }
  }),
  tool({
    name: 'get_workspace',
    description: 'Gets one workspace: status, repo, machine size, current session lease and the last error, if any.',
    input: WorkspaceId,
    annotations: read('Get workspace'),
    run: async (args, api) => fromApi(await api('GET', `/v1/workspaces/${args.workspaceId}`))
  }),
  tool({
    name: 'create_workspace',
    description:
      'Starts a new Orca Cloud workspace: a fresh cloud VM with the repo checked out, ready for coding agents. Start it from a project (projectId) or a repo URL. Optionally pass `message` to hand the agent its first task; it is queued and delivered as soon as the VM is up (follow it with get_message). Usually takes 10-60 seconds and uses the account\'s cloud minutes.',
    input: z
      .object({
        name: z.string().trim().min(1).max(100).optional().describe('Display name for the workspace.'),
        projectId: Id('project').optional().describe('Project to start from (see list_projects). Supplies the repo and machine defaults.'),
        repoUrl: z.url({ protocol: /^https$/ }).max(2048).optional().describe('https Git URL to clone when not using a project, e.g. https://github.com/acme/app.'),
        ref: z.string().min(1).max(255).optional().describe('Branch, tag or commit to check out (default: the repo default branch).'),
        machineSize: z.enum(['standard', 'large']).optional().describe('VM size; large has more CPU and memory and costs more.'),
        message: z.string().min(1).max(32_000).optional().describe('First task for the agent in the new workspace.'),
        agent: Agent.optional()
      })
      .strict(),
    annotations: { title: 'Create workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, api) =>
      fromApi(
        await api('POST', '/v1/workspaces', {
          ...(args.name ? { name: args.name } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
          ...(args.repoUrl ? { repo: { url: args.repoUrl, ...(args.ref ? { ref: args.ref } : {}) } } : {}),
          ...(args.machineSize ? { machineSize: args.machineSize } : {}),
          ...(args.message ? { message: { text: args.message, ...(args.agent ? { agent: args.agent } : {}) } } : {})
        })
      )
  }),
  tool({
    name: 'sleep_workspace',
    description: 'Puts a running workspace to sleep: the VM stops and its disk is kept, so nothing is billed until wake_workspace. Running agents stop.',
    input: WorkspaceId,
    annotations: { title: 'Sleep workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, api) => fromApi(await api('POST', `/v1/workspaces/${args.workspaceId}/sleep`))
  }),
  tool({
    name: 'wake_workspace',
    description: 'Wakes a sleeping workspace (restores the VM with its disk). Returns once it is running again.',
    input: WorkspaceId,
    annotations: { title: 'Wake workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, api) => fromApi(await api('POST', `/v1/workspaces/${args.workspaceId}/wake`))
  }),
  tool({
    name: 'archive_workspace',
    description: 'Archives a workspace: it is put to sleep and hidden from default lists. Its disk is kept and it can still be woken.',
    input: WorkspaceId,
    annotations: { title: 'Archive workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, api) => fromApi(await api('POST', `/v1/workspaces/${args.workspaceId}/archive`))
  }),
  tool({
    name: 'destroy_workspace',
    description: 'Permanently destroys a workspace and its VM disk. Uncommitted and unpushed work in it is lost. This cannot be undone.',
    input: WorkspaceId,
    annotations: { title: 'Destroy workspace', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (args, api) => fromApi(await api('DELETE', `/v1/workspaces/${args.workspaceId}`))
  }),
  tool({
    name: 'send_message',
    description:
      'Sends a message to a coding agent in a workspace. Without `session` it starts a new agent session with the message as its prompt; with `session` (a handle from list_sessions or a previous message) it continues that conversation. Sleeping workspaces are woken first. The tool waits up to `waitSeconds` for delivery and returns the message status (queued, delivering, delivered, failed); check later with get_message. Read the agent\'s progress with list_sessions.',
    input: z
      .object({
        workspaceId: Id('workspace'),
        text: z.string().min(1).max(32_000).describe('The message or task for the agent.'),
        agent: Agent.optional(),
        session: z.string().regex(/^term_[A-Za-z0-9-]{1,80}$/).optional().describe('Session handle to continue (from list_sessions or a previous message).'),
        waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait for delivery (0-${MAX_WAIT_SECONDS}, default 20).`)
      })
      .strict(),
    annotations: { title: 'Send message to agent', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, api) => {
      const response = await api('POST', `/v1/workspaces/${args.workspaceId}/messages`, {
        text: args.text,
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.session ? { session: args.session } : {})
      })
      if (!response.ok) {
        return fromApi(response)
      }
      let { message } = (await response.json()) as { message: { id: string; status: string } }
      const deadline = Date.now() + (args.waitSeconds ?? 20) * 1000
      while ((message.status === 'queued' || message.status === 'delivering') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const polled = await api('GET', `/v1/workspaces/${args.workspaceId}/messages/${message.id}`)
        if (!polled.ok) {
          break
        }
        message = ((await polled.json()) as { message: typeof message }).message
      }
      return ok({ message })
    }
  }),
  tool({
    name: 'get_message',
    description: 'Gets the delivery status of a message sent with send_message or create_workspace, including the agent session handle it went to.',
    input: z.object({ workspaceId: Id('workspace'), messageId: Id('message') }).strict(),
    annotations: read('Get message'),
    run: async (args, api) => fromApi(await api('GET', `/v1/workspaces/${args.workspaceId}/messages/${args.messageId}`))
  }),
  tool({
    name: 'list_sessions',
    description:
      'Lists the agent sessions (terminals) running in a workspace with their handle, agent, title, whether they are connected and a short preview of their latest output. Use the handle as `session` in send_message to continue a conversation. Returns no sessions when the workspace is not running.',
    input: WorkspaceId,
    annotations: read('List agent sessions'),
    run: async (args, api) => fromApi(await api('GET', `/v1/workspaces/${args.workspaceId}/sessions`))
  }),
  tool({
    name: 'read_session',
    description:
      "Reads what an agent session in a workspace currently shows on screen (the rendered terminal, up to ~16k characters) and its status. Use it to see an agent's answer or progress after send_message; get the handle from list_sessions or the message's `session`.",
    input: z.object({ workspaceId: Id('workspace'), session: z.string().regex(/^term_[A-Za-z0-9-]{1,80}$/).describe('Session handle (term_…) from list_sessions or a message.') }).strict(),
    annotations: read('Read agent session'),
    run: async (args, api) => fromApi(await api('GET', `/v1/workspaces/${args.workspaceId}/sessions/${args.session}`))
  }),
  tool({
    name: 'list_routines',
    description: 'Lists routines: saved agent prompts that run in a fresh workspace on a schedule, a GitHub event or a webhook, with their trigger and last run.',
    input: z.object({}).strict(),
    annotations: read('List routines'),
    run: async (_args, api) => fromApi(await api('GET', '/v1/routines'))
  }),
  tool({
    name: 'run_routine',
    description: 'Runs a routine now, in a fresh workspace, regardless of its schedule. Returns the run (follow its workspaceId with get_workspace / list_sessions). Fails with conflict if the routine already has an active run.',
    input: z.object({ routineId: Id('routine') }).strict(),
    annotations: { title: 'Run routine now', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, api) => fromApi(await api('POST', `/v1/routines/${args.routineId}/run`))
  })
]

const BY_NAME = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.name, t]))

function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

let listCache: unknown[] | null = null

export function toolList(): unknown[] {
  listCache ??= TOOLS.map((t) => ({
    name: t.name,
    title: t.annotations.title,
    description: t.description,
    inputSchema: inputSchema(t.input),
    annotations: t.annotations
  }))
  return listCache
}

export function hasTool(name: string): boolean {
  return BY_NAME.has(name)
}

export async function callTool(name: string, args: unknown, api: ApiCall): Promise<ToolResult> {
  const def = BY_NAME.get(name)!
  const parsed = def.input.safeParse(args ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return toolError('invalid_arguments', { detail: issue ? `${issue.path.join('.') || 'arguments'}: ${issue.message}` : 'invalid' })
  }
  return (def.run as (a: unknown, api: ApiCall) => Promise<ToolResult>)(parsed.data, api)
}
