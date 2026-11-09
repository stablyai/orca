// /v1/routines REST group, mounted on the public API as an ApiExtension (same auth, rate limit and
// error mapping as the rest of /v1). Members see every routine in the org and edit their own;
// owners/admins edit all. A run always executes as the routine's creator.
//   GET    /v1/routines                         -> {routines}
//   POST   /v1/routines                         -> 201 {routine, webhookUrl?}
//   GET    /v1/routines/:id                     -> {routine}
//   PATCH  /v1/routines/:id                     -> {routine, webhookUrl?}
//   DELETE /v1/routines/:id                     -> {deleted: true}
//   POST   /v1/routines/:id/run                 -> 202 {run}
//   POST   /v1/routines/:id/rotate-webhook      -> {url}
//   GET    /v1/routines/:id/runs?limit=&before= -> {runs, nextBefore}
//   GET    /v1/routines/:id/runs/:runId         -> {run}
import { z } from 'zod'
import { auditCaller, consumeRate } from '../api/audit'
import { ApiError, isAdmin, requireScope, type ApiCaller } from '../api/caller'
import type { ApiContext, ApiExtension } from '../api/router'
import { AGENTS } from '../api/vm-agent'
import { getProject, insertProject, type ProjectRow } from '../api/workspaces'
import { parseGitHubRepo } from '../github-app'
import { RunRefusedError, cancelRoutineRuns, enqueueRun, type RoutineDeps } from './runs'
import { ScheduleError, nextRunAfter, parseRoutineSchedule } from './schedule'
import {
  GITHUB_EVENTS,
  getRoutine,
  getRun,
  insertRoutine,
  listRoutines,
  listRuns,
  newWebhookSecret,
  routineView,
  runView,
  softDeleteRoutine,
  triggerConfig,
  updateRoutine,
  type RoutinePatch,
  type RoutineRecord,
  type TriggerConfig
} from './store'

export const MAX_PROMPT_CHARS = 20_000
const MANUAL_RUNS_PER_MINUTE = 10

const Name = z.string().trim().min(1).max(100)
const RepoUrl = z.url({ protocol: /^https$/ }).max(2048)
const Ref = z.string().min(1).max(255)
const Label = z.string().trim().min(1).max(100)
const Login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/)

const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), cron: z.string().trim().min(1).max(256), timezone: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('github'),
      events: z.array(z.enum(GITHUB_EVENTS)).min(1).max(GITHUB_EVENTS.length),
      labels: z.array(Label).max(20).optional(),
      authors: z.array(Login).max(50).optional(),
      baseBranches: z.array(Ref).max(20).optional()
    })
    .strict(),
  z.object({ kind: z.literal('webhook') }).strict()
])

const RoutineFields = {
  name: Name,
  projectId: z.string().max(64).optional(),
  repo: z.object({ url: RepoUrl, ref: Ref.optional() }).strict().optional(),
  trigger: Trigger,
  agent: z.enum(AGENTS),
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
  postResults: z.enum(['none', 'comment', 'pr']),
  enabled: z.boolean().optional(),
  machineSize: z.enum(['standard', 'large']).optional(),
  maxRuntimeMinutes: z.number().int().min(5).max(120).optional()
}
const CreateBody = z.object(RoutineFields).strict()
const PatchBody = z.object(RoutineFields).partial().strict()
type CreateInput = z.infer<typeof CreateBody>

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ApiError(400, 'invalid_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined)
  }
  return result.data
}

/**
 * A run executes with its creator's personal secrets, so only the creator may change what runs
 * (prompt, project, agent, trigger, posting) or start it. Owners/admins may switch a member's routine
 * off or delete it, never repoint it.
 */
function isCreator(caller: ApiCaller, routine: Pick<RoutineRecord, 'created_by'>): boolean {
  return routine.created_by === caller.userId
}

/** Who may see a run's private detail (trigger payload, log tail, the creator's run workspace). */
function seesRunDetail(caller: ApiCaller, routine: Pick<RoutineRecord, 'created_by'>): boolean {
  return isCreator(caller, routine) || isAdmin(caller)
}

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
}

/** projectId, or a repo that reuses the account's project for it (same URL and ref) or makes one. */
async function resolveProject(ctx: ApiContext, caller: ApiCaller, input: { projectId?: string; repo?: { url: string; ref?: string } }): Promise<ProjectRow> {
  if (input.projectId) {
    return getProject(ctx.db, caller.accountId, input.projectId)
  }
  const repo = input.repo!
  const { results } = await ctx.db
    .prepare('SELECT * FROM projects WHERE account_id = ? AND archived_at IS NULL AND repo_url IS NOT NULL ORDER BY created_at LIMIT 500')
    .bind(caller.accountId)
    .all<ProjectRow>()
  const existing = results.find(
    (project) => normalizeRepoUrl(project.repo_url!) === normalizeRepoUrl(repo.url) && (repo.ref === undefined || (project.default_ref ?? null) === repo.ref)
  )
  if (existing) {
    return existing
  }
  const github = parseGitHubRepo(repo.url)
  const base = (github ? `${github.owner}/${github.repo}` : new URL(repo.url).pathname.replace(/^\/+|\/+$/g, '') || 'project') + (repo.ref ? ` @ ${repo.ref}` : '')
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const project = await insertProject(
        ctx.db,
        {
          account_id: caller.accountId,
          name: (attempt === 1 ? base : `${base} (${attempt})`).slice(0, 100),
          repo_url: repo.url,
          default_ref: repo.ref ?? null,
          machine_size: 'standard',
          region: null,
          build_id: null,
          created_by: caller.userId
        },
        ctx.now()
      )
      await auditCaller(ctx.db, caller, { action: 'project.create', targetType: 'project', targetId: project.id, detail: { name: project.name, via: 'routine' } }, ctx.now())
      return project
    } catch (error) {
      if (!(error instanceof ApiError && error.reason === 'project_name_taken')) {
        throw error
      }
    }
  }
  throw new ApiError(409, 'conflict', 'project_name_taken')
}

function triggerColumns(trigger: z.infer<typeof Trigger>): { kind: TriggerConfig['kind']; config: string } {
  const { kind, ...config } = trigger
  return { kind, config: JSON.stringify(config) }
}

function nextRunFor(caller: ApiCaller, trigger: z.infer<typeof Trigger>, now: number): number | null {
  if (trigger.kind !== 'schedule') {
    return null
  }
  try {
    // Dev accounts may schedule every minute (testing); everyone else gets the 15-minute floor.
    const rule = parseRoutineSchedule(trigger.cron, trigger.timezone, { allowFrequent: caller.dev === true })
    return nextRunAfter(rule, trigger.timezone, now)
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw new ApiError(400, 'invalid_request', `trigger: ${error.reason}`)
    }
    throw error
  }
}

/** Cross-field rules: GitHub triggers and PR/comment posting need a github.com repo. */
function checkCoherent(project: ProjectRow, trigger: z.infer<typeof Trigger>, postResults: CreateInput['postResults']): void {
  const onGitHub = project.repo_url !== null && parseGitHubRepo(project.repo_url) !== null
  if ((trigger.kind === 'github' || postResults !== 'none') && !onGitHub) {
    throw new ApiError(400, 'invalid_request', trigger.kind === 'github' ? 'trigger: github_repo_required' : 'postResults: github_repo_required')
  }
}

function webhookUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/v1/hooks/${token}`
}

async function visibleRoutine(ctx: ApiContext, caller: ApiCaller, id: string): Promise<RoutineRecord> {
  const routine = await getRoutine(ctx.db, id)
  if (!routine || routine.account_id !== caller.accountId) {
    throw new ApiError(404, 'not_found')
  }
  return routine
}

function requireCreator(caller: ApiCaller, routine: RoutineRecord): void {
  if (!isCreator(caller, routine)) {
    throw new ApiError(403, 'forbidden', 'not_owner')
  }
}

function requireCreatorOrAdmin(caller: ApiCaller, routine: RoutineRecord): void {
  if (!isCreator(caller, routine) && !isAdmin(caller)) {
    throw new ApiError(403, 'forbidden', 'not_owner')
  }
}

export function createRoutinesApi(options: { publicUrl: string; deps: () => RoutineDeps | null }): ApiExtension {
  return async (request, url, caller, ctx) => {
    const parts = url.pathname.split('/').filter(Boolean).slice(1)
    const [resource, id, sub, subId, extra] = parts
    if (resource !== 'routines' || extra !== undefined) {
      return null
    }
    const method = request.method
    const now = ctx.now()

    if (!id && method === 'GET') {
      requireScope(caller, 'routines:read')
      return json({ routines: (await listRoutines(ctx.db, caller.accountId)).map(routineView) })
    }

    if (!id && method === 'POST') {
      requireScope(caller, 'routines:write')
      const body = parse(CreateBody, await ctx.readJson())
      if ((body.projectId === undefined) === (body.repo === undefined)) {
        throw new ApiError(400, 'invalid_request', 'body: exactly one of projectId or repo')
      }
      const nextRunAt = nextRunFor(caller, body.trigger, now)
      const project = await resolveProject(ctx, caller, body)
      checkCoherent(project, body.trigger, body.postResults)
      const webhook = body.trigger.kind === 'webhook' ? await newWebhookSecret() : null
      const trigger = triggerColumns(body.trigger)
      const routineId = await insertRoutine(
        ctx.db,
        {
          account_id: caller.accountId,
          created_by: caller.userId,
          name: body.name,
          project_id: project.id,
          enabled: body.enabled === false ? 0 : 1,
          trigger_kind: trigger.kind,
          trigger_config: trigger.config,
          agent: body.agent,
          prompt: body.prompt,
          machine_size: body.machineSize ?? project.machine_size ?? 'standard',
          post_results: body.postResults,
          max_runtime_ms: (body.maxRuntimeMinutes ?? 30) * 60_000,
          next_run_at: nextRunAt
        },
        webhook,
        now
      )
      await auditCaller(ctx.db, caller, { action: 'routine.create', targetType: 'routine', targetId: routineId, detail: { name: body.name, trigger: trigger.kind, agent: body.agent, postResults: body.postResults } }, now)
      const routine = (await getRoutine(ctx.db, routineId))!
      // The only time the webhook URL is ever returned.
      return json({ routine: routineView(routine), ...(webhook ? { webhookUrl: webhookUrl(options.publicUrl, webhook.token) } : {}) }, 201)
    }

    if (!id) {
      return null
    }
    const routine = await visibleRoutine(ctx, caller, id)

    if (!sub && method === 'GET') {
      requireScope(caller, 'routines:read')
      return json({ routine: routineView(routine) })
    }

    if (!sub && method === 'PATCH') {
      requireScope(caller, 'routines:write')
      const body = parse(PatchBody, await ctx.readJson())
      if (!isCreator(caller, routine)) {
        // Admins may only switch someone else's routine off (they can also delete it).
        if (!isAdmin(caller) || Object.keys(body).some((key) => key !== 'enabled') || body.enabled !== false) {
          throw new ApiError(403, 'forbidden', 'not_owner')
        }
      }
      if (body.projectId !== undefined && body.repo !== undefined) {
        throw new ApiError(400, 'invalid_request', 'body: at most one of projectId or repo')
      }
      const patch: RoutinePatch = {}
      let project: ProjectRow | null = null
      if (body.projectId !== undefined || body.repo !== undefined) {
        project = await resolveProject(ctx, caller, body)
        patch.project_id = project.id
      }
      const current = triggerConfig(routine)
      const { kind: _kind, ...currentConfig } = current
      const trigger = body.trigger ?? ({ kind: current.kind, ...currentConfig } as z.infer<typeof Trigger>)
      const enabled = body.enabled ?? routine.enabled === 1
      if (body.trigger) {
        const columns = triggerColumns(body.trigger)
        patch.trigger_kind = columns.kind
        patch.trigger_config = columns.config
      }
      if (body.trigger || body.enabled !== undefined) {
        patch.next_run_at = nextRunFor(caller, trigger, now)
      }
      let webhook = null
      if (body.trigger && body.trigger.kind === 'webhook' && routine.trigger_kind !== 'webhook') {
        webhook = await newWebhookSecret()
        patch.webhook = webhook
      } else if (body.trigger && body.trigger.kind !== 'webhook' && routine.trigger_kind === 'webhook') {
        patch.webhook = null
      }
      if (body.name !== undefined) patch.name = body.name
      if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
      if (body.agent !== undefined) patch.agent = body.agent
      if (body.prompt !== undefined) patch.prompt = body.prompt
      if (body.postResults !== undefined) patch.post_results = body.postResults
      if (body.machineSize !== undefined) patch.machine_size = body.machineSize
      if (body.maxRuntimeMinutes !== undefined) patch.max_runtime_ms = body.maxRuntimeMinutes * 60_000
      if (project || body.trigger || body.postResults) {
        project ??= await getProject(ctx.db, caller.accountId, routine.project_id)
        checkCoherent(project, trigger, body.postResults ?? routine.post_results)
      }
      await updateRoutine(ctx.db, routine, patch, now)
      if (body.enabled === false) {
        const deps = options.deps()
        if (deps) {
          await cancelRoutineRuns(deps, routine.id, { active: false })
        }
      }
      await auditCaller(ctx.db, caller, { action: 'routine.update', targetType: 'routine', targetId: routine.id, detail: { fields: Object.keys(body) } }, now)
      const next = (await getRoutine(ctx.db, routine.id))!
      return json({ routine: routineView(next), ...(webhook ? { webhookUrl: webhookUrl(options.publicUrl, webhook.token) } : {}) })
    }

    if (!sub && method === 'DELETE') {
      requireScope(caller, 'routines:write')
      requireCreatorOrAdmin(caller, routine)
      await softDeleteRoutine(ctx.db, routine.id, now)
      const deps = options.deps()
      if (deps) {
        // Queued runs end now; VMs of in-flight runs are destroyed (the tick sweep retries any that fail).
        ctx.waitUntil(cancelRoutineRuns(deps, routine.id, { active: true }))
      }
      await auditCaller(ctx.db, caller, { action: 'routine.delete', targetType: 'routine', targetId: routine.id, detail: { name: routine.name } }, now)
      return json({ deleted: true })
    }

    if (sub === 'run' && !subId && method === 'POST') {
      requireScope(caller, 'routines:write')
      requireCreator(caller, routine)
      await consumeRate(ctx.db, `routine-run:${routine.id}`, MANUAL_RUNS_PER_MINUTE, now)
      let run
      try {
        run = await enqueueRun(ctx.db, routine, { trigger: 'manual', detail: { requestedBy: caller.userId }, dedupeKey: null }, now)
      } catch (error) {
        if (error instanceof RunRefusedError) {
          throw new ApiError(409, 'conflict', error.reason)
        }
        throw error
      }
      await auditCaller(ctx.db, caller, { action: 'routine.run', targetType: 'routine', targetId: routine.id, detail: { runId: run.id } }, now)
      return json({ run: runView(run, { private: true }) }, 202)
    }

    if (sub === 'rotate-webhook' && !subId && method === 'POST') {
      requireScope(caller, 'routines:write')
      requireCreator(caller, routine)
      if (routine.trigger_kind !== 'webhook') {
        throw new ApiError(409, 'conflict', 'not_a_webhook_routine')
      }
      const webhook = await newWebhookSecret()
      // One UPDATE replaces id and hash together: the old URL stops resolving immediately.
      await updateRoutine(ctx.db, routine, { webhook }, now)
      await auditCaller(ctx.db, caller, { action: 'routine.rotate_webhook', targetType: 'routine', targetId: routine.id }, now)
      return json({ url: webhookUrl(options.publicUrl, webhook.token) })
    }

    if (sub === 'runs' && method === 'GET') {
      requireScope(caller, 'routines:read')
      if (!subId) {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
        const before = Number(url.searchParams.get('before')) || undefined
        const rows = await listRuns(ctx.db, routine.id, { before, limit })
        const detail = seesRunDetail(caller, routine)
        return json({ runs: rows.map((row) => runView(row, { private: detail })), nextBefore: rows.length === limit ? rows.at(-1)!.created_at : null })
      }
      const run = await getRun(ctx.db, subId)
      if (!run || run.routine_id !== routine.id) {
        throw new ApiError(404, 'not_found')
      }
      return json({ run: runView(run, { private: seesRunDetail(caller, routine), logTail: true }) })
    }

    return null
  }
}
