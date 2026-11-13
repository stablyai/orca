// Account credentials for agents (agent-sources contract D11): one per person per agent, Personal only.
//   GET    /v1/agent-credentials                  -> {claude, codex: {state, label?, expiresAt?}, providerEnabled, providerState}
//   PUT    /v1/agent-credentials/claude {token, label?, expiresAt?}   (flag S1; desktop main runs `claude setup-token`)
//   POST   /v1/agent-credentials/claude/verify -> {claude, verifiedAt, checked}   (pre-launch check, agent-credential-checks.ts)
//   DELETE /v1/agent-credentials/:agent
// Values are never returned or logged. They leave the Worker only when the egress proxy swaps them into a
// request from the person's own, unshared workspace (D10, D13). The Codex broker (flag S2) stores its tokens
// through putAgentCredential too (codex-broker.ts).
import { z } from 'zod'
import type { CredentialAgent } from './agent-credential-names'
import type { SandboxCaller } from './auth'
import type { Env } from './env'
import type { Keyring, SecretBinding } from './secrets-crypto'

/**
 * 'suspect' (RS-2): an auth check failed but no real request has confirmed it yet. Still usable at egress;
 * shown to the desktop as expired + needsCheck (an older desktop reads a new state as 'none').
 */
export type CredentialState = 'none' | 'active' | 'expiring' | 'expired' | 'revoked' | 'suspect'
const EXPIRING_MS = 30 * 24 * 60 * 60_000
/** `claude setup-token` issues a one-year token. */
const CLAUDE_SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000

type CredentialRow = {
  user_id: string
  account_id: string
  agent: CredentialAgent
  kek_id: string
  wrapped_dek: string
  ciphertext: string
  label: string | null
  expires_at: number | null
  state: 'active' | 'revoked'
  /** RS-2: when an auth check said this sign-in is dead; null when not in question. */
  suspect_at?: number | null
  updated_at: number
}

export class AgentCredentialError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 503,
    readonly code: string,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
  }
}

/** The AAD every account credential is sealed with; the Codex lease refresher must reuse it exactly. */
export const credentialBinding = (userId: string, agent: CredentialAgent): SecretBinding => ({ scope: 'account', ownerId: userId, name: agent })

/**
 * Why a provider is or isn't usable, so clients word it right: `off` = flag S1/S2 not on (never offered here),
 * `disabled` = the operator kill switch on a launched provider (temporary).
 */
export type ProviderState = 'on' | 'off' | 'disabled'

export function providerStates(env: Pick<Env, 'AGENT_ACCOUNTS_CLAUDE' | 'AGENT_ACCOUNTS_CLAUDE_DISABLED' | 'AGENT_ACCOUNTS_CODEX' | 'AGENT_ACCOUNTS_CODEX_DISABLED'>): Record<CredentialAgent, ProviderState> {
  const state = (flag: string | undefined, disabled: string | undefined): ProviderState => (flag !== 'on' ? 'off' : disabled === '1' ? 'disabled' : 'on')
  return {
    claude: state(env.AGENT_ACCOUNTS_CLAUDE, env.AGENT_ACCOUNTS_CLAUDE_DISABLED),
    codex: state(env.AGENT_ACCOUNTS_CODEX, env.AGENT_ACCOUNTS_CODEX_DISABLED)
  }
}

/** Flags S1/S2 turn a provider on; the *_DISABLED switch turns it off again (kill switch, operator-only). */
export function providerEnabled(env: Pick<Env, 'AGENT_ACCOUNTS_CLAUDE' | 'AGENT_ACCOUNTS_CLAUDE_DISABLED' | 'AGENT_ACCOUNTS_CODEX' | 'AGENT_ACCOUNTS_CODEX_DISABLED'>): Record<CredentialAgent, boolean> {
  const states = providerStates(env)
  return { claude: states.claude === 'on', codex: states.codex === 'on' }
}

export function credentialState(row: Pick<CredentialRow, 'state' | 'expires_at' | 'suspect_at'> | null, now: number): CredentialState {
  if (!row) {
    return 'none'
  }
  if (row.state === 'revoked') {
    return 'revoked'
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    return 'expired'
  }
  if (row.suspect_at !== null && row.suspect_at !== undefined) {
    return 'suspect'
  }
  if (row.expires_at !== null && row.expires_at - now <= EXPIRING_MS) {
    return 'expiring'
  }
  return 'active'
}

/** Usable for a request now: active or expiring (still valid), or suspect (a real request must confirm it). */
export function isUsable(state: CredentialState): boolean {
  return state === 'active' || state === 'expiring' || state === 'suspect'
}

async function rowFor(db: D1Database, userId: string, agent: CredentialAgent): Promise<CredentialRow | null> {
  return db.prepare('SELECT * FROM agent_credentials WHERE user_id = ? AND agent = ?').bind(userId, agent).first<CredentialRow>()
}

export async function agentCredentialState(db: D1Database, userId: string, agent: CredentialAgent, now: number): Promise<CredentialState> {
  return credentialState(await rowFor(db, userId, agent), now)
}

export async function putAgentCredential(
  db: D1Database,
  keyring: Keyring,
  input: { userId: string; accountId: string; agent: CredentialAgent; value: string; label?: string | null; expiresAt?: number | null },
  now: number
): Promise<void> {
  const sealed = await keyring.seal(credentialBinding(input.userId, input.agent), input.value)
  await db
    .prepare(
      `INSERT INTO agent_credentials (user_id, account_id, agent, kek_id, wrapped_dek, ciphertext, label, expires_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (user_id, agent) DO UPDATE SET account_id = excluded.account_id, kek_id = excluded.kek_id,
         wrapped_dek = excluded.wrapped_dek, ciphertext = excluded.ciphertext, label = excluded.label,
         expires_at = excluded.expires_at, state = 'active', updated_at = excluded.updated_at,
         checked_at = NULL, verified_at = NULL, suspect_at = NULL`
    )
    .bind(input.userId, input.accountId, input.agent, sealed.kekId, sealed.wrappedDek, sealed.ciphertext, input.label ?? null, input.expiresAt ?? null, now, now)
    .run()
}

/** The real value for egress, or null when there is none or it can't be used now. */
export async function readUsableAgentCredential(db: D1Database, keyring: Keyring, userId: string, agent: CredentialAgent, now: number): Promise<string | null> {
  return (await readUsableAgentCredentialState(db, keyring, userId, agent, now)).value
}

/** The real value for egress, and whether the sign-in is in question (RS-2: a real request confirms it). */
export async function readUsableAgentCredentialState(
  db: D1Database,
  keyring: Keyring,
  userId: string,
  agent: CredentialAgent,
  now: number
): Promise<{ value: string | null; suspect: boolean }> {
  const row = await rowFor(db, userId, agent)
  const state = credentialState(row, now)
  if (!isUsable(state) || !row) {
    return { value: null, suspect: false }
  }
  try {
    const value = await keyring.open(credentialBinding(userId, agent), { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext })
    return { value, suspect: state === 'suspect' }
  } catch {
    console.log(JSON.stringify({ event: 'agent_credential_unreadable', agent }))
    return { value: null, suspect: false }
  }
}

/** RS-2: an auth check failed. Not revoked: a real request must confirm it first. True when newly marked. */
export async function markAgentCredentialSuspect(db: D1Database, userId: string, agent: CredentialAgent, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE agent_credentials SET suspect_at = ?, updated_at = ? WHERE user_id = ? AND agent = ? AND state = 'active' AND suspect_at IS NULL`)
    .bind(now, now, userId, agent)
    .run()
  return result.meta.changes === 1
}

/** RS-2: a real request (or an auth check) succeeded: the sign-in is fine. True when it was in question. */
export async function clearAgentCredentialSuspect(db: D1Database, userId: string, agent: CredentialAgent, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE agent_credentials SET suspect_at = NULL, updated_at = ? WHERE user_id = ? AND agent = ? AND suspect_at IS NOT NULL`)
    .bind(now, userId, agent)
    .run()
  return result.meta.changes === 1
}

/** RS-2: when this sign-in was put in question, or null. */
export async function agentCredentialSuspectAt(db: D1Database, userId: string, agent: CredentialAgent): Promise<number | null> {
  const row = await db
    .prepare(`SELECT suspect_at FROM agent_credentials WHERE user_id = ? AND agent = ? AND state = 'active'`)
    .bind(userId, agent)
    .first<{ suspect_at: number | null }>()
  return row?.suspect_at ?? null
}

/** The provider said the credential is no longer valid (401 at egress): stop using it until renewed. */
export async function markAgentCredentialRevoked(db: D1Database, userId: string, agent: CredentialAgent, now: number): Promise<void> {
  await db.prepare(`UPDATE agent_credentials SET state = 'revoked', suspect_at = NULL, updated_at = ? WHERE user_id = ? AND agent = ?`).bind(now, userId, agent).run()
}

export async function deleteAgentCredential(db: D1Database, userId: string, agent: CredentialAgent): Promise<boolean> {
  const result = await db.prepare('DELETE FROM agent_credentials WHERE user_id = ? AND agent = ?').bind(userId, agent).run()
  return result.meta.changes === 1
}

export async function agentCredentialsView(db: D1Database, env: Env, userId: string, now: number) {
  const { results } = await db.prepare('SELECT * FROM agent_credentials WHERE user_id = ?').bind(userId).all<CredentialRow>()
  const view = (agent: CredentialAgent) => {
    const row = results.find((r) => r.agent === agent) ?? null
    const state = credentialState(row, now)
    // RS-2: "needs check" reads as expired (the Renew strip) on every desktop, old ones included; newer
    // desktops may read needsCheck. An unknown state would read as 'none' ("isn't set up") on old ones.
    const wire = state === 'suspect' ? { state: 'expired' as const, needsCheck: true } : { state }
    // RS-5: credentials saved before the fix carry an email or the Orca name; Claude's always reads true.
    const label = agent === 'claude' && row ? CLAUDE_CREDENTIAL_LABEL : row?.label
    return { ...wire, ...(label ? { label } : {}), ...(row?.expires_at ? { expiresAt: row.expires_at } : {}) }
  }
  return { claude: view('claude'), codex: view('codex'), providerEnabled: providerEnabled(env), providerState: providerStates(env) }
}

/** RS-5: what a stored Claude credential is called (the approved account itself can't be known). */
export const CLAUDE_CREDENTIAL_LABEL = 'Claude subscription'

// A Claude setup-token: `sk-ant-oat01-` then URL-safe characters. Shape-checked, never logged.
const CLAUDE_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,500}$/
export const PutClaudeSchema = z
  .object({
    token: z.string().max(600),
    label: z.string().max(200).optional(),
    expiresAt: z.number().int().positive().optional()
  })
  .strict()

export async function putClaudeCredential(db: D1Database, keyring: Keyring, env: Env, caller: SandboxCaller, body: z.infer<typeof PutClaudeSchema>, now: number) {
  if (env.AGENT_ACCOUNTS_CLAUDE !== 'on') {
    throw new AgentCredentialError(404, 'not_found')
  }
  const token = body.token.trim()
  if (!CLAUDE_TOKEN.test(token)) {
    throw new AgentCredentialError(400, 'invalid_request', 'invalid_token')
  }
  // Personal only: a person's account is never stored for a team (D13 keeps it out of shared workspaces too).
  await putAgentCredential(
    db,
    keyring,
    {
      userId: caller.userId,
      accountId: caller.accountId,
      agent: 'claude',
      value: token,
      // RS-5 (design-squad): a true label only. Neither this computer's Claude Code email nor the Orca
      // name says which account approved the setup-token (it prints no email, and its inference-only
      // scope can't read the profile), so a Claude credential is always "Claude subscription".
      label: CLAUDE_CREDENTIAL_LABEL,
      expiresAt: Math.min(body.expiresAt ?? now + CLAUDE_SETUP_TOKEN_TTL_MS, now + CLAUDE_SETUP_TOKEN_TTL_MS)
    },
    now
  )
  // Names only, never the value.
  console.log(JSON.stringify({ event: 'agent_credential_written', agent: 'claude', by: caller.userId }))
}
