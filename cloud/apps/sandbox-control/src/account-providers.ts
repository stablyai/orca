// "Via your Orca account" (agent-sources contract D10/D13): an agent signs in once, account-wide, and every one
// of the person's own cloud workspaces uses that account through an egress placeholder. The sandbox never holds
// the real credential. The proxy picks per request, so renewals, Source changes and the kill switch apply to
// the next request. One provider per agent: Claude here (A1 spike: `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`
// is accepted and sent as `Authorization: Bearer`), Codex in codex-credentials.ts.
import type { CredentialAgent } from './agent-credential-names'
import { readUsableAgentCredential } from './agent-credentials'
import { codexAccount } from './codex-credentials'
import type { Keyring } from './secrets-crypto'
import type { SandboxRow } from './store'

export type AccountProvider = {
  agent: CredentialAgent
  /** Egress hosts where the account placeholder is swapped (also allowlisted while the account applies). */
  hosts: readonly string[]
  /** Env the session gets while the account applies: placeholders only. */
  sessionEnv(row: Pick<SandboxRow, 'id'>): Record<string, string>
  /** Header the client sends the placeholder in. */
  header: string
  placeholder(row: Pick<SandboxRow, 'id'>): string
  format(credential: string): string
  /** Narrows the account route to these requests (Codex: its ChatGPT backend APIs, not all of chatgpt.com). */
  pathAllowed?(method: string, path: string): boolean
  /** Extra headers derived from the real credential (e.g. Codex's ChatGPT account id). */
  extraHeaders?(credential: string): Record<string, string>
  /**
   * The provider answered 401 to this credential. Default (absent): mark it revoked. Codex instead
   * kicks a single-flight lease refresh, which marks it expired/revoked itself if the refresh token is dead.
   */
  onUnauthorized?(ctx: { db: D1Database; keyring: Keyring; userId: string; now: number; waitUntil: (work: Promise<unknown>) => void }): Promise<void>
  /** The real value for this person, or null (none, expired, revoked). */
  credential(db: D1Database, keyring: Keyring, userId: string, now: number): Promise<string | null>
}

/** D13: a workspace shared with teammates never uses a personal account. */
export function isSharedWorkspace(row: Pick<SandboxRow, 'visibility'>): boolean {
  return row.visibility === 'team'
}

export const claudeAccount: AccountProvider = {
  agent: 'claude',
  // Messages plus the OAuth-side endpoints Claude Code calls with the same token (A1 spike).
  hosts: ['api.anthropic.com'],
  placeholder: (row) => `orca-ph-claude-account-${row.id}`,
  sessionEnv: (row) => ({ CLAUDE_CODE_OAUTH_TOKEN: `orca-ph-claude-account-${row.id}` }),
  header: 'authorization',
  format: (credential) => `Bearer ${credential}`,
  credential: (db, keyring, userId, now) => readUsableAgentCredential(db, keyring, userId, 'claude', now)
}

export const ACCOUNT_PROVIDERS: AccountProvider[] = [claudeAccount, codexAccount]

export function accountProvider(agent: CredentialAgent): AccountProvider | undefined {
  return ACCOUNT_PROVIDERS.find((provider) => provider.agent === agent)
}
