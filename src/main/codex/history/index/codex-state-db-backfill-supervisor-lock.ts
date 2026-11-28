import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { withManagedHookInstallLock } from '../../../agent-hooks/installation/locking/managed-hook-install-lock'
import { readManagedHookHostIdentity } from '../../../agent-hooks/installation/locking/managed-hook-owner-identity'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'

const RECOVERY_OWNER_CHECK_TIMEOUT_MS = 1_000

export function resolveCodexBackfillSupervisorLockRoot(codexHomePath: string): string {
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const digest = createHash('sha256').update(homeKey).digest('hex')
  return join(getOrcaUserDataPath(), 'codex-state-db-backfill-locks', digest)
}

function scopeRecoveryHostIdentity(hostIdentity: string, codexHomePath: string): string {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  return wslHome ? `${hostIdentity}:wsl:${wslHome.distro.toLowerCase()}` : hostIdentity
}

export async function withCodexBackfillSupervisorLock<T>(
  codexHomePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const hostIdentity = scopeRecoveryHostIdentity(await readManagedHookHostIdentity(), codexHomePath)
  return await withManagedHookInstallLock(
    resolveCodexBackfillSupervisorLockRoot(codexHomePath),
    signal,
    run,
    hostIdentity,
    { waitTimeoutMs: RECOVERY_OWNER_CHECK_TIMEOUT_MS }
  )
}
