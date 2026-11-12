import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { expandLeadingHomePath } from '../../filesystem/home-path-expansion'

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
    // Native: the on-disk spelling, as file authorization's realpath returns it on case-insensitive disks.
    const canonicalPath = resolve(realpathSync.native(resolveFloatingWorkspacePath(trimmed, home)))
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null
  } catch {
    return null
  }
}

/** Store a trusted cwd in its canonical spelling so file authorization can match it without I/O. */
export function canonicalTrustedFloatingTerminalCwd(
  cwd: string,
  trustedCwds: readonly string[],
  home: string
): string {
  if (cwd.trim() === '~') {
    return cwd
  }
  const canonicalCwd = canonicalizePersistedFloatingWorkspaceDirectory(cwd, home)
  return canonicalCwd && trustedCwds.includes(canonicalCwd) ? canonicalCwd : cwd
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
    // Spelling only, never through links: the approval-time realpath is the trusted root's identity,
    // so a trusted folder later swapped for a link must not re-point its trust at the link's target.
    const normalizedPath = resolveFloatingWorkspacePath(trimmedTrustedCwd, home)
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
