// Per-account programmatic-access settings, and the per-boot workspace token for the in-VM CLI.
import type { SandboxProviderApi } from '../sandbox-provider'
import type { SandboxRow } from '../store'
import { audit } from './audit'
import { WORKSPACE_TOKEN_SCOPES, mintApiKey, revokeWorkspaceTokens } from './keys'
import { installWorkspaceToken } from './vm-agent'

export type AccountSettings = { vmCliEnabled: boolean }

export async function getAccountSettings(db: D1Database, accountId: string): Promise<AccountSettings> {
  const row = await db
    .prepare('SELECT vm_cli_enabled FROM account_settings WHERE account_id = ?')
    .bind(accountId)
    .first<{ vm_cli_enabled: number }>()
  return { vmCliEnabled: row?.vm_cli_enabled === 1 }
}

export async function putAccountSettings(
  db: D1Database,
  accountId: string,
  settings: AccountSettings,
  by: string,
  now: number
): Promise<AccountSettings> {
  await db
    .prepare(
      `INSERT INTO account_settings (account_id, vm_cli_enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET vm_cli_enabled = excluded.vm_cli_enabled,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .bind(accountId, settings.vmCliEnabled ? 1 : 0, by, now)
    .run()
  return settings
}

/** Workspace tokens outlive no session: a day at most even if a stop is missed. */
const WORKSPACE_TOKEN_TTL_MS = 24 * 60 * 60_000

/**
 * After every boot: revoke the previous session's token, then (if the org allows in-VM access)
 * mint a fresh one for this VM and write it where the `orca` CLI reads it. Best effort: a failure
 * here never fails the boot, it only leaves the CLI without cloud access.
 */
export async function provisionWorkspaceToken(
  deps: { db: D1Database; provider: SandboxProviderApi; now: () => number; apiUrl?: string },
  row: SandboxRow,
  sessionId: string
): Promise<'installed' | 'disabled' | 'failed'> {
  try {
    await revokeWorkspaceTokens(deps.db, row.id, deps.now())
    const settings = await getAccountSettings(deps.db, row.account_id)
    if (!settings.vmCliEnabled || !deps.apiUrl) {
      return 'disabled'
    }
    const minted = await mintApiKey(
      deps.db,
      {
        accountId: row.account_id,
        createdBy: row.user_id,
        name: `workspace ${row.id}`,
        scopes: WORKSPACE_TOKEN_SCOPES,
        kind: 'workspace',
        sandboxId: row.id,
        expiresAt: deps.now() + WORKSPACE_TOKEN_TTL_MS
      },
      deps.now()
    )
    await installWorkspaceToken(deps.provider, sessionId, { secret: minted.secret, apiUrl: deps.apiUrl, workspaceId: row.id })
    await audit(deps.db, { accountId: row.account_id, type: 'system', id: 'control-plane', userId: row.user_id }, { action: 'workspace_token.issue', targetType: 'workspace', targetId: row.id, detail: { keyId: minted.row.id } }, deps.now())
    return 'installed'
  } catch (error) {
    console.log(JSON.stringify({ event: 'workspace_token_failed', sandboxId: row.id, error: String(error).slice(0, 120) }))
    return 'failed'
  }
}
