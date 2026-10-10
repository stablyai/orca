import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getOwnedCodexAccountHomePaths } from './codex-account-home-discovery'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from './codex-home-paths'
import {
  clearPendingCodexMirrorCleanup,
  readCodexProjectTrustLedger,
  releaseCodexProjectTrust
} from './codex-project-trust-ledger'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { projectTrustTableTrusts } from './config-toml-project-trust'
import { removeOrcaWrittenProjectTrustTables } from './config-toml-project-trust-removal'
import { writeConfigAtomically } from './config-toml-trust'

export type CodexProjectTrustRevocation = {
  /** The removed workspace's root; trust Orca wrote for it or any folder below is revoked. */
  removedRoot: string
  /** Roots of workspaces that remain; one at or below `removedRoot` keeps its own trust. */
  remainingRoots: readonly string[]
}

/**
 * Removes the Codex project trust Orca's pre-trust created for a removed local
 * workspace (#24697), then the copies the config mirror carried into each
 * managed account home. Only ledgered tables still in Orca's exact shape go.
 */
export async function revokeCodexProjectTrustForRemovedWorkspace(
  revocation: CodexProjectTrustRevocation
): Promise<void> {
  const removedForms = withCanonicalForm(revocation.removedRoot)
  const isUnderRemovedRoot = (path: string): boolean =>
    removedForms.some((root) => isPathInsideOrEqual(root, path))
  // Why: an enclosing workspace (a repo holding `.worktrees/x`) must not shield x's trust.
  const keptRoots = revocation.remainingRoots.flatMap(withCanonicalForm).filter(isUnderRemovedRoot)
  const isRevoked = (projectPath: string): boolean =>
    isUnderRemovedRoot(projectPath) &&
    !keptRoots.some((root) => isPathInsideOrEqual(root, projectPath))

  const released: Record<string, string[]> = {}
  for (const [configFile, ledgeredPaths] of Object.entries(readCodexProjectTrustLedger().configs)) {
    const candidates = ledgeredPaths.filter(isRevoked)
    if (candidates.length > 0) {
      await removeTables(configFile, (path) => candidates.includes(path))
      // Why: a table the user changed since is theirs now; stop tracking it either way.
      released[configFile] = candidates
    }
  }
  const releasedPaths = [...new Set(Object.values(released).flat())]
  if (releasedPaths.length > 0) {
    releaseCodexProjectTrust(released, releasedPaths.filter(isUntrustedByEverySource))
  }
  // Why: also retries copies a previous revocation could not reach.
  await removePendingMirrorCopies()
}

/** Account homes copy source tables, so a copy may go only once no source still trusts its path. */
function isUntrustedByEverySource(projectPath: string): boolean {
  return [
    join(resolveOrcaManagedCodexHomePath(), 'config.toml'),
    join(getSystemCodexHomePath(), 'config.toml')
  ].every((file) => !projectTrustTableTrusts(readConfigOrEmpty(file), projectPath))
}

async function removePendingMirrorCopies(): Promise<void> {
  const pending = readCodexProjectTrustLedger().pendingMirrorCleanup
  if (pending.length === 0) {
    return
  }
  // Why: a path pre-trusted again since its release has a live source; its copies stay.
  const removable = pending.filter(isUntrustedByEverySource)
  for (const accountHome of getOwnedCodexAccountHomePaths({ strict: true })) {
    await removeTables(join(accountHome, 'config.toml'), (path) => removable.includes(path))
  }
  clearPendingCodexMirrorCleanup(pending)
}

function removeTables(
  configFile: string,
  shouldRemove: (projectPath: string) => boolean
): Promise<void> {
  return runExclusivelyForCodexTrustConfig(configFile, async () => {
    const existing = readConfigOrEmpty(configFile)
    const { content } = removeOrcaWrittenProjectTrustTables(existing, shouldRemove)
    if (content !== existing) {
      writeConfigAtomically(configFile, content)
    }
  })
}

function readConfigOrEmpty(configFile: string): string {
  try {
    return readFileSync(configFile, 'utf-8')
  } catch (error) {
    // Why: an unreadable source may still trust the path, so only definitive absence reads as empty.
    if (isDefinitiveAbsence(error)) {
      return ''
    }
    throw error
  }
}

// Why: pre-trust stores realpaths, and a removed checkout can no longer be realpath'd itself.
function withCanonicalForm(path: string): string[] {
  try {
    if (existsSync(path)) {
      return [path, realpathSync.native(path)]
    }
    return [path, join(realpathSync.native(dirname(path)), basename(path))]
  } catch {
    return [path]
  }
}
