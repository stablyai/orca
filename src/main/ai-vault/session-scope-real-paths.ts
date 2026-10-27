import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault-scope-cwd-match'
import { parseWslUncPath } from '../../shared/wsl-paths'

type AiVaultScopeLink = { scopePath: string; realPath: string }

export type AiVaultScopeRealPaths = {
  /** Admit both registered spellings and resolved paths. */
  scanScopePaths: readonly string[]
  links: readonly AiVaultScopeLink[]
}

/** Resolve on the execution host so links refer to the filesystem that recorded each cwd. */
export async function resolveAiVaultScopeRealPaths(
  scopePaths: readonly string[]
): Promise<AiVaultScopeRealPaths> {
  const links: AiVaultScopeLink[] = []
  for (const scopePath of scopePaths) {
    // Windows cannot resolve Linux symlinks through a WSL UNC share.
    if (!isAbsolute(scopePath) || parseWslUncPath(scopePath)) {
      continue
    }
    const realPath = await realpath(scopePath).catch(() => null)
    if (realPath && !sameComparisonPath(realPath, scopePath)) {
      links.push({ scopePath, realPath })
    }
  }
  const scanScopePaths = [...scopePaths]
  const seen = new Set(scopePaths.map(normalizeRuntimePathForComparison))
  for (const { realPath } of links) {
    const key = normalizeRuntimePathForComparison(realPath)
    if (!seen.has(key)) {
      seen.add(key)
      scanScopePaths.push(realPath)
    }
  }
  return { scanScopePaths, links }
}

/** Add matching-only aliases without resolving arbitrary cwds on network mounts or protected folders. */
export function attachAiVaultScopeCwdAliases(
  result: AiVaultListResult,
  scope: AiVaultScopeRealPaths
): AiVaultListResult {
  if (scope.links.length === 0) {
    return result
  }
  const aliasesByCwd = new Map<string, string[]>()
  let changed = false
  const sessions: AiVaultSession[] = []
  for (const session of result.sessions) {
    const cwd = session.cwd
    // Windows cannot resolve the Linux cwds carried by WSL rows.
    if (!cwd || !isAbsolute(cwd) || sessionFileExecutionNamespace(session.filePath) !== 'native') {
      sessions.push(session)
      continue
    }
    let aliases = aliasesByCwd.get(cwd)
    if (!aliases) {
      aliases = scopeAliasesFor(cwd, scope.links)
      aliasesByCwd.set(cwd, aliases)
    }
    if (aliases.length === 0) {
      sessions.push(session)
      continue
    }
    changed = true
    sessions.push({ ...session, cwdAliases: aliases })
  }
  return changed ? { ...result, sessions } : result
}

function scopeAliasesFor(cwd: string, links: readonly AiVaultScopeLink[]): string[] {
  const aliases: string[] = []
  for (const { scopePath, realPath } of links) {
    const suffix = relativePathInsideRoot(realPath, cwd)
    if (suffix !== null) {
      aliases.push(suffix ? join(scopePath, suffix) : scopePath)
    }
  }
  return aliases
}

function sameComparisonPath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}
