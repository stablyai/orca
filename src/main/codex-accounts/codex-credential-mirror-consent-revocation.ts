import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'

// Why: markSharedRuntimeAuthManaged (runtime-home-service-auth-provenance.ts) is the only writer
// of `owner: 'managed'`; a retained managed pane's own refreshed credential can live in the same
// shared auth.json, so revoking the *mirror's* consent must not delete that pane's copy (G3).
// A parse failure or any other shape is treated as not managed-owned, matching the prior
// unconditional-delete behavior for every state this repo doesn't recognize as "managed".
function isManagedOwnedProvenance(provenancePath: string): boolean {
  if (!existsSync(provenancePath)) {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(provenancePath, 'utf-8'))
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'owner' in parsed &&
      parsed.owner === 'managed'
    )
  } catch {
    return false
  }
}

// Why: revoking mirror consent must remove the credential copies it already made, not just stop future ones.
export function clearMirroredCodexCredentials(): void {
  const provenancePath = join(
    getOrcaUserDataPath(),
    'codex-runtime-home',
    'shared-runtime-auth-provenance.json'
  )
  if (!isManagedOwnedProvenance(provenancePath)) {
    rmSync(join(resolveOrcaManagedCodexHomePath(), 'auth.json'), { force: true })
    // Why: shared-runtime-auth-provenance.json also stores a full credential copy (authJson /
    // runtimeAuthJson); a revoked consent must not leave it behind either (G2) -- but only the
    // system-default copy, never a retained managed pane's ownership record (G3).
    rmSync(provenancePath, { force: true })
  }
  rmSync(join(getOrcaUserDataPath(), 'codex-runtime-home', 'system-default-auth.json'), {
    force: true
  })
  // Why: the no-consent logout marker can still be stamped from a prior, consented sync and holds
  // a system-default authJson snapshot; revocation must remove that copy too (G3).
  rmSync(join(getOrcaUserDataPath(), 'codex-runtime-home', 'system-default-runtime-logout.json'), {
    force: true
  })
}
