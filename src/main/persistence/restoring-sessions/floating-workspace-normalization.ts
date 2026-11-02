import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { expandLeadingHomePath } from '../../home-path-expansion'

export function resolveFloatingWorkspacePath(input: string, home: string): string {
  const expanded = expandLeadingHomePath(input, home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded)
}

export function canonicalizePersistedFloatingWorkspaceDirectory(
  input: string,
  home: string
): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    const canonicalPath = resolve(realpathSync(resolveFloatingWorkspacePath(trimmed, home)))
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null
  } catch {
    return null
  }
}

export function normalizeFloatingWorkspaceTrustedCwds(
  input: unknown,
  home: string
): { trustedCwds: string[]; changed: boolean } {
  const rawTrustedCwds = Array.isArray(input) ? input : []
  const trustedCwds: string[] = []
  const seen = new Set<string>()
  let changed = input !== undefined && !Array.isArray(input)

  for (const rawTrustedCwd of rawTrustedCwds) {
    if (typeof rawTrustedCwd !== 'string') {
      changed = true
      continue
    }
    const trimmedTrustedCwd = rawTrustedCwd.trim()
    if (!trimmedTrustedCwd) {
      changed = true
      continue
    }
    const canonicalPath = canonicalizePersistedFloatingWorkspaceDirectory(trimmedTrustedCwd, home)
    const normalizedPath = canonicalPath ?? resolveFloatingWorkspacePath(trimmedTrustedCwd, home)
    if (!normalizedPath) {
      changed = true
      continue
    }
    if (seen.has(normalizedPath)) {
      changed = true
      continue
    }
    seen.add(normalizedPath)
    trustedCwds.push(normalizedPath)
    if (rawTrustedCwd !== normalizedPath) {
      changed = true
    }
  }

  return { trustedCwds, changed }
}
