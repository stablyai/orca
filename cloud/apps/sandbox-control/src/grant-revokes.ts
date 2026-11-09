// Removing member devices from a workspace's orcad. Shared by grants.ts (revoke now) and the
// lifecycle boot path (revokes queued while the VM was suspended run before orcad starts).
import type { SandboxProviderApi } from './sandbox-provider'
import { withEntryPoints } from './grants'

export const REVOKE_COMMAND = '/opt/orca/bin/orca-sandbox-revoke'
const REVOKE_TIMEOUT_MS = 30_000

export type GrantStatus = 'issuing' | 'active' | 'revoking' | 'revoked' | 'failed'

export type GrantRow = {
  id: string
  sandbox_id: string
  account_id: string
  user_id: string
  device_kind: 'desktop' | 'mobile'
  device_label: string
  orcad_device_id: string | null
  status: GrantStatus
  created_at: number
  revoked_at: number | null
  revoked_by: string | null
  revoke_reason: string | null
  device_session_id: string | null
}

/** Runs the VM revoke for these grants; true when orcad's registry no longer lists them. */
export async function runVmRevoke(
  provider: SandboxProviderApi,
  sessionId: string,
  grants: readonly GrantRow[]
): Promise<boolean> {
  const ids = grants.map((g) => g.orcad_device_id).filter((id): id is string => !!id && /^[A-Za-z0-9_-]+$/.test(id))
  if (ids.length === 0) {
    return true
  }
  try {
    const result = await withEntryPoints({ provider }, sessionId, REVOKE_COMMAND, () =>
      provider.runCommand(sessionId, {
        command: REVOKE_COMMAND,
        env: { ORCA_REVOKE_DEVICE_IDS: ids.join(',') },
        timeoutMs: REVOKE_TIMEOUT_MS
      })
    )
    return result.exitCode === 0
  } catch {
    return false
  }
}

/** Boot hook: apply every revoke queued while the sandbox was not running. Throws if it cannot. */
export async function applyQueuedRevokes(
  db: D1Database,
  provider: SandboxProviderApi,
  sandboxId: string,
  sessionId: string,
  now: number
): Promise<number> {
  const { results } = await db
    .prepare(`SELECT * FROM workspace_grants WHERE sandbox_id = ? AND status = 'revoking'`)
    .bind(sandboxId)
    .all<GrantRow>()
  if (results.length === 0) {
    return 0
  }
  if (!(await runVmRevoke(provider, sessionId, results))) {
    // Never start orcad with a revoked member still able to sign in.
    throw new Error('queued_revoke_failed')
  }
  await markRevoked(db, results, now)
  return results.length
}

export async function markRevoked(db: D1Database, grants: readonly GrantRow[], now: number): Promise<void> {
  if (grants.length === 0) {
    return
  }
  await db.batch(
    grants.map((g) =>
      db.prepare(`UPDATE workspace_grants SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).bind(now, g.id)
    )
  )
}
