import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  AiVaultProjectSuggestion,
  AiVaultProjectSuggestionSource
} from '../../shared/ai-vault-project-suggestions'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

const RESOLVE_CONCURRENCY = 4

export type ResolveGitRoot = (
  cwd: string
) => Promise<{ toplevel: string; commonDir: string } | null>

export type SessionProjectSuggestionInput = {
  sources: readonly AiVaultProjectSuggestionSource[]
  registeredRepoPaths: readonly string[]
  dismissedPaths: readonly string[]
  homeDir: string
  tempDirs: readonly string[]
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

// Why realpath: a symlinked home (e.g. /home -> /var/home) must not let ~/.cache sessions slip past.
// Why catch everything: a corrupted transcript cwd (NUL byte, EACCES) must drop that one path only.
function canonicalDir(path: string): string | null {
  try {
    if (!isAbsolute(path) || statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
      return null
    }
    return realpathSync.native(path)
  } catch {
    return null
  }
}

type EligibilityRoots = { home: string; excluded: string[] }

function eligibilityRoots(input: SessionProjectSuggestionInput): EligibilityRoots {
  const home = canonicalDir(input.homeDir) ?? input.homeDir
  const excluded = [...input.tempDirs, join(home, '.cache'), join(home, '.config')].map(
    (dir) => canonicalDir(dir) ?? dir
  )
  return { home, excluded }
}

// Why: session cwds include benchmark worktrees, scratch dirs and tool caches; only folders a
// person works in should become projects.
function eligibleDir(path: string, roots: EligibilityRoots): string | null {
  const dir = canonicalDir(path)
  if (!dir || dir === roots.home || dir === dirname(roots.home) || dir === dirname(dir)) {
    return null
  }
  return roots.excluded.some((root) => isInside(dir, root)) ? null : dir
}

// Why the common dir: a linked worktree reports itself as toplevel, so worktree sessions would
// otherwise suggest transient checkouts instead of the repo that owns them.
function mainRepoRoot(cwd: string, resolved: { toplevel: string; commonDir: string }): string {
  const commonDir = resolve(cwd, resolved.commonDir)
  // Why resolve: git prints forward slashes on Windows; registered repos use native separators.
  return resolve(basename(commonDir) === '.git' ? dirname(commonDir) : resolved.toplevel)
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export async function suggestProjectsFromSessions(
  input: SessionProjectSuggestionInput,
  resolveGitRoot: ResolveGitRoot
): Promise<AiVaultProjectSuggestion[]> {
  const sessionsByCwd = new Map<string, AiVaultProjectSuggestionSource[]>()
  for (const source of input.sources) {
    const list = sessionsByCwd.get(source.cwd) ?? []
    list.push(source)
    sessionsByCwd.set(source.cwd, list)
  }
  const roots = eligibilityRoots(input)
  const cwds = [...sessionsByCwd.keys()].flatMap((cwd) => {
    const dir = eligibleDir(cwd, roots)
    return dir ? [{ cwd, dir }] : []
  })
  const repoRoots = await mapWithConcurrency(cwds, RESOLVE_CONCURRENCY, async ({ dir }) => {
    try {
      const resolved = await resolveGitRoot(dir)
      return resolved ? mainRepoRoot(dir, resolved) : null
    } catch {
      return null
    }
  })

  const skip = new Set(
    [...input.registeredRepoPaths, ...input.dismissedPaths].map((path) =>
      normalizeRuntimePathForComparison(canonicalDir(path) ?? path)
    )
  )
  const byRoot = new Map<string, AiVaultProjectSuggestion>()
  cwds.forEach(({ cwd }, index) => {
    const repoRoot = repoRoots[index]
    const eligibleRoot = repoRoot ? eligibleDir(repoRoot, roots) : null
    if (!eligibleRoot || skip.has(normalizeRuntimePathForComparison(eligibleRoot))) {
      return
    }
    const entry = byRoot.get(eligibleRoot) ?? {
      path: eligibleRoot,
      name: basename(eligibleRoot),
      sessionCount: 0,
      agents: []
    }
    for (const source of sessionsByCwd.get(cwd) ?? []) {
      entry.sessionCount += 1
      if (!entry.agents.includes(source.agent)) {
        entry.agents.push(source.agent)
      }
    }
    byRoot.set(eligibleRoot, entry)
  })
  return [...byRoot.values()].sort(
    (a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name)
  )
}
