// Agent Source per person (agent-sources contract §2): "Your sign-in" or "API key", per agent, as a
// default plus an optional per-workspace override, and the one-time "Use my sign-in" offer answer (D8).
//   GET /v1/agent-sources[?workspaceId=<sandbox id>]
//   PUT /v1/agent-sources        {agent, source: 'sign-in'|'key'|null, workspaceId?}
//   PUT /v1/agent-sources/offer  {agent, answer: 'accepted'|'declined'}
// A sandbox applies its OWNER's effective source: with 'sign-in', that agent's credential names are left
// out of the session env (and so out of egress routes, the allowlist and gateway derivation), letting
// the agent's own login inside the sandbox win. Variables are never touched.
import { z } from 'zod'
import { AGENT_CREDENTIAL_NAMES, CREDENTIAL_AGENTS, type CredentialAgent } from './agent-credential-names'
import type { SandboxCaller } from './auth'
import { memberNamesFor } from './member-names'
import { effectiveSecrets } from './secrets'
import { getSandbox, type SandboxRow } from './store'
import { agentCredentialState, isUsable } from './agent-credentials'
import { accountProvider, isSharedWorkspace } from './account-providers'

export type AgentSource = 'sign-in' | 'key'
type OfferAnswer = 'unanswered' | 'accepted' | 'declined'
const DEFAULT_SCOPE = 'default'
const OFFER_SCOPE = 'offer'

type SourceRow = { scope: string; agent: CredentialAgent; source: string }

const AgentSchema = z.enum(['claude', 'codex'])
export const PutSourceSchema = z
  .object({
    agent: AgentSchema,
    source: z.enum(['sign-in', 'key']).nullable(),
    workspaceId: z.string().min(1).max(128).optional()
  })
  .strict()
export const PutOfferSchema = z.object({ agent: AgentSchema, answer: z.enum(['accepted', 'declined']) }).strict()

export class AgentSourceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: string,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
  }
}

async function rowsFor(db: D1Database, userId: string, scopes: string[]): Promise<SourceRow[]> {
  const { results } = await db
    .prepare(`SELECT scope, agent, source FROM agent_sources WHERE user_id = ? AND scope IN (${scopes.map(() => '?').join(', ')})`)
    .bind(userId, ...scopes)
    .all<SourceRow>()
  return results
}

function byAgent(rows: SourceRow[], scope: string): Record<CredentialAgent, AgentSource | null> {
  const out = { claude: null, codex: null } as Record<CredentialAgent, AgentSource | null>
  for (const row of rows) {
    if (row.scope === scope && (row.source === 'sign-in' || row.source === 'key')) {
      out[row.agent] = row.source
    }
  }
  return out
}

/** Agents whose owner chose "Your sign-in" for this sandbox (override first, then default). */
export async function signInAgentsFor(db: D1Database, row: Pick<SandboxRow, 'id' | 'user_id'>): Promise<Set<CredentialAgent>> {
  const rows = await rowsFor(db, row.user_id, [row.id, DEFAULT_SCOPE])
  const workspace = byAgent(rows, row.id)
  const defaults = byAgent(rows, DEFAULT_SCOPE)
  return new Set(CREDENTIAL_AGENTS.filter((agent) => (workspace[agent] ?? defaults[agent]) === 'sign-in'))
}

/** Drops the credential names of agents on "Your sign-in" (after preset derivation, so derived ones go too). */
export function withoutSignInCredentials<T extends Record<string, unknown>>(env: T, signIn: ReadonlySet<CredentialAgent>): T {
  if (signIn.size === 0) {
    return env
  }
  const next: Record<string, unknown> = { ...env }
  for (const agent of signIn) {
    for (const name of AGENT_CREDENTIAL_NAMES[agent]) {
      delete next[name]
    }
  }
  return next as T
}

/** Some agent key the caller's sessions would get covers this agent (the gateway key covers both). */
function coveredByKey(names: ReadonlySet<string>): Record<CredentialAgent, boolean> {
  const gateway = names.has('AI_GATEWAY_API_KEY')
  return {
    claude: gateway || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some((n) => names.has(n)),
    codex: gateway || names.has('OPENAI_API_KEY')
  }
}

async function ownedWorkspace(db: D1Database, caller: SandboxCaller, workspaceId: string): Promise<SandboxRow> {
  const row = await getSandbox(db, workspaceId)
  if (!row || row.account_id !== caller.accountId || row.status === 'destroyed') {
    throw new AgentSourceError(404, 'not_found')
  }
  return row
}

export async function agentSourcesView(
  db: D1Database,
  caller: SandboxCaller,
  workspaceId: string | null,
  enabled: Record<CredentialAgent, boolean> = { claude: false, codex: false },
  now: number = Date.now()
) {
  const row = workspaceId ? await ownedWorkspace(db, caller, workspaceId) : null
  // The sandbox applies its owner's choice (shared sandboxes, v1): show the owner's, not the caller's.
  const subject = row ? row.user_id : caller.userId
  const rows = await rowsFor(db, subject, [DEFAULT_SCOPE, OFFER_SCOPE, ...(row ? [row.id] : [])])
  const defaults = byAgent(rows, DEFAULT_SCOPE)
  const workspace = row ? byAgent(rows, row.id) : null
  const effective = await effectiveSecrets(db, caller, row?.repo_url ?? null)
  const covered = coveredByKey(new Set(effective.map((secret) => secret.name)))
  // v4: with no key covering it, a set-up Orca account is the default (no question asked).
  const usable = {} as Record<CredentialAgent, boolean>
  for (const agent of CREDENTIAL_AGENTS) {
    usable[agent] = enabled[agent] && isUsable(await agentCredentialState(db, subject, agent, now))
  }
  const offerRows = rows.filter((r) => r.scope === OFFER_SCOPE)
  const signInOffer = Object.fromEntries(
    CREDENTIAL_AGENTS.map((agent) => [
      agent,
      (offerRows.find((r) => r.agent === agent)?.source as OfferAnswer | undefined) ?? 'unanswered'
    ])
  ) as Record<CredentialAgent, OfferAnswer>
  const resolved = Object.fromEntries(
    CREDENTIAL_AGENTS.map((agent) => {
      const chosen = workspace?.[agent] ?? null
      if (chosen) {
        return [agent, { source: chosen, origin: 'workspace' }]
      }
      if (defaults[agent]) {
        return [agent, { source: defaults[agent], origin: 'default' }]
      }
      return [agent, { source: covered[agent] ? 'key' : usable[agent] ? 'sign-in' : null, origin: 'implicit' }]
    })
  )
  let owner: { userId: string; displayName: string | null; isCaller: boolean } | null = null
  if (row) {
    const names = await memberNamesFor(db, caller.accountId, [row.user_id])
    owner = { userId: row.user_id, displayName: names.get(row.user_id) ?? null, isCaller: row.user_id === caller.userId }
  }
  // D13: personal accounts never apply in a workspace shared with teammates.
  const sharedWorkspace = row ? isSharedWorkspace(row) : false
  return { defaults, workspace, effective: resolved, coveredByKey: covered, signInOffer, owner, sharedWorkspace }
}

async function upsert(db: D1Database, caller: SandboxCaller, scope: string, agent: CredentialAgent, source: string | null, now: number) {
  if (source === null) {
    await db.prepare('DELETE FROM agent_sources WHERE user_id = ? AND scope = ? AND agent = ?').bind(caller.userId, scope, agent).run()
    return
  }
  await db
    .prepare(
      `INSERT INTO agent_sources (user_id, account_id, scope, agent, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, scope, agent) DO UPDATE SET source = excluded.source, account_id = excluded.account_id, updated_at = excluded.updated_at`
    )
    .bind(caller.userId, caller.accountId, scope, agent, source, now)
    .run()
}

/** Returns the sandbox whose session env must refresh (a running one whose owner's source changed), if any. */
export async function putAgentSource(db: D1Database, caller: SandboxCaller, body: z.infer<typeof PutSourceSchema>, now: number) {
  let row: SandboxRow | null = null
  if (body.workspaceId) {
    row = await ownedWorkspace(db, caller, body.workspaceId)
    if (row.user_id !== caller.userId) {
      throw new AgentSourceError(403, 'forbidden', 'owner_only')
    }
  }
  // D9: accepted while the sandbox is still starting; its first boot reads the row.
  await upsert(db, caller, row ? row.id : DEFAULT_SCOPE, body.agent, body.source, now)
  return row
}

export async function putOfferAnswer(db: D1Database, caller: SandboxCaller, body: z.infer<typeof PutOfferSchema>, now: number) {
  await upsert(db, caller, OFFER_SCOPE, body.agent, body.answer, now)
}

/** Running sandboxes of this person that a default change affects (no workspace override for that agent). */
export async function runningSandboxesForDefault(db: D1Database, userId: string, agent: CredentialAgent): Promise<SandboxRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.* FROM sandboxes s WHERE s.user_id = ? AND s.status = 'running'
       AND NOT EXISTS (SELECT 1 FROM agent_sources a WHERE a.user_id = s.user_id AND a.scope = s.id AND a.agent = ?)
       LIMIT 200`
    )
    .bind(userId, agent)
    .all<SandboxRow>()
  return results
}

export async function deleteAgentSourcesForSandbox(db: D1Database, sandboxId: string): Promise<void> {
  await db.prepare('DELETE FROM agent_sources WHERE scope = ?').bind(sandboxId).run()
}

/**
 * How each agent authenticates in this session (D10):
 * - 'account': the owner's Orca-account credential through an egress placeholder (keys for that agent dropped);
 * - 'omit':    kill-switch fallback (Source sign-in, provider off): keys dropped, the agent's own login in the sandbox;
 * - 'keep':    API keys as resolved (precedence), the default.
 * Source: explicit (workspace, then default), else implicit: a covering key wins, else a usable account.
 */
export type AgentMode = 'account' | 'omit' | 'keep'
export async function agentModesFor(
  db: D1Database,
  row: Pick<SandboxRow, 'id' | 'user_id' | 'visibility' | 'ownership_transferred_at'>,
  env: Readonly<Record<string, string>>,
  options: {
    providerEnabled: Record<CredentialAgent, boolean>
    accountsUsable: boolean
    now: number
    readable?: (agent: CredentialAgent) => Promise<boolean>
  }
): Promise<Record<CredentialAgent, AgentMode>> {
  const rows = await rowsFor(db, row.user_id, [row.id, DEFAULT_SCOPE])
  const workspace = byAgent(rows, row.id)
  const defaults = byAgent(rows, DEFAULT_SCOPE)
  const covered = coveredByKey(new Set(Object.keys(env)))
  const modes = {} as Record<CredentialAgent, AgentMode>
  for (const agent of CREDENTIAL_AGENTS) {
    const explicit = workspace[agent] ?? defaults[agent]
    const provider = accountProvider(agent)
    const enabled = options.providerEnabled[agent] && provider !== undefined
    const usable = enabled
      ? isUsable(await agentCredentialState(db, row.user_id, agent, options.now)) && (options.readable ? await options.readable(agent) : true)
      : false
    const source = explicit ?? (covered[agent] ? 'key' : usable ? 'sign-in' : null)
    if (source !== 'sign-in') {
      modes[agent] = 'keep'
    } else if (!enabled) {
      // Kill switch (or no provider yet): the agent signs in inside the sandbox; keys stay out (Rule 3).
      modes[agent] = 'omit'
    } else if (usable && options.accountsUsable && !isSharedWorkspace(row)) {
      modes[agent] = 'account'
    } else {
      // Expired/revoked, placeholders off, or a shared workspace (D13): the winning key, if any.
      modes[agent] = 'keep'
    }
  }
  return modes
}
