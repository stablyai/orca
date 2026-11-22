import { ConcurrentFileEditError } from '../../../filesystem/concurrent-file-edit-guard'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import type { CodexHookPassEffects } from './codex-hook-install-effects'
import { stripCodexManagedHookEffects } from './codex-hook-managed-strip'
import { writeCodexRuntimeUserHookRefreshEffects } from './codex-hook-refresh-effects'

/** Off mid-flight: rebuild first so user approvals leave the slots Orca's group shifted, then strip. */
export function writeCodexOffStripEffects(
  runtimeHomePath: string,
  codexHashes: readonly CodexHookHashes[]
): CodexHookPassEffects {
  try {
    // An unreadable system hooks.json leaves the runtime hooks as they are; the strip still runs.
    writeCodexRuntimeUserHookRefreshEffects(runtimeHomePath)
  } catch (error) {
    if (error instanceof ConcurrentFileEditError) {
      throw error
    }
    console.warn('[codex-hook-service] user-hook rebuild before strip failed', error)
  }
  return stripCodexManagedHookEffects(runtimeHomePath, codexHashes)
}
