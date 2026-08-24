// Git stores refs as files under `.git/refs`, so `feature` and `feature/x` can
// never both exist: one name would have to be a file and a directory at once.
// Creating the second one fails with `cannot lock ref ... exists`. This module
// detects that collision before a create runs, so worktree creation can suffix
// the name (or explain itself) instead of surfacing raw git text.

const REFS_HEADS = 'refs/heads/'

export type BranchConflictKind = 'local' | 'local-directory' | 'local-ref-prefix' | 'remote'

/**
 * Conflict kinds no suffix can escape, so a create loop should stop retrying
 * instead of burning every candidate.
 *
 * Suffixes are appended to the last segment of the branch name, which leaves
 * every proper prefix intact: if `release` blocks `release/1.0`, it blocks
 * `release/1.0-2` through `release/1.0-100` too. Retrying is provably futile,
 * and over SSH each attempt costs several remote round trips.
 */
export function isUnsuffixableBranchConflict(kind: BranchConflictKind | null): boolean {
  return kind === 'local-ref-prefix'
}

/** Map a detected directory/file collision onto the conflict kind callers switch on. */
export function branchRefDirectoryConflictKind(
  conflict: BranchRefDirectoryConflict
): BranchConflictKind {
  return conflict.direction === 'file' ? 'local-ref-prefix' : 'local-directory'
}

/**
 * Which side of the directory/file rule blocks the name.
 *
 * - `directory`: existing refs nest *under* the requested name (`feature/x`
 *   blocks `feature`).
 * - `file`: an existing ref is a path *prefix* of the requested name
 *   (`release` blocks `release/1.0`).
 */
export type BranchRefDirectoryConflict = {
  direction: 'directory' | 'file'
  /** The existing branch responsible for the collision. */
  existingBranch: string
}

/** Proper `/`-prefixes of a branch name, longest first: `a/b/c` -> [`a/b`, `a`]. */
function properBranchPrefixes(branchName: string): string[] {
  const segments = branchName.split('/')
  const prefixes: string[] = []
  for (let count = segments.length - 1; count > 0; count -= 1) {
    prefixes.push(segments.slice(0, count).join('/'))
  }
  return prefixes
}

/**
 * `for-each-ref` argv listing every local ref that could collide with
 * `branchName` under git's directory/file rule.
 *
 * A `for-each-ref` pattern matches a ref completely *or* up to a `/` boundary,
 * so `refs/heads/feature` returns both `refs/heads/feature` and
 * `refs/heads/feature/x` while never matching `refs/heads/featurex`. One
 * invocation therefore covers both directions: the requested name's own pattern
 * finds refs nested under it, and each proper-prefix pattern finds a shorter ref
 * blocking it.
 *
 * Known limitation: `for-each-ref` matches ref names byte-for-byte, while the
 * ref *store* on macOS/Windows is usually case-insensitive and may normalize
 * unicode. So `Feature/x` blocking `feature`, or an NFC ref blocking an NFD
 * name, is not detected here and still reaches git. `--ignore-case` is
 * deliberately not used: on a case-sensitive volume git genuinely allows both
 * `feature` and `Feature/x`, so it would block names git accepts — a false
 * positive, which is worse than the raw error this misses. Those cases fail
 * exactly as they do today.
 *
 * Safe for git 2.25 — multi-pattern `for-each-ref` long predates the baseline.
 * Every argument is `refs/heads/`-prefixed, so a branch name can never be read
 * as an option, and `check-ref-format` has already rejected the glob characters
 * (`*?[\`) that would otherwise make these patterns match too much.
 */
export function buildBranchRefConflictArgv(branchName: string): string[] {
  return [
    'for-each-ref',
    '--format=%(refname)',
    `${REFS_HEADS}${branchName}`,
    ...properBranchPrefixes(branchName).map((prefix) => `${REFS_HEADS}${prefix}`)
  ]
}

/**
 * Classify `buildBranchRefConflictArgv` output. Returns null when `branchName`
 * is creatable.
 *
 * The prefix patterns deliberately over-match — probing `release/1.0` also
 * returns unrelated siblings like `release/2.0` — so a prefix only counts when
 * the returned ref equals it exactly.
 */
export function classifyBranchRefDirectoryConflict(
  branchName: string,
  stdout: string
): BranchRefDirectoryConflict | null {
  const prefixes = new Set(properBranchPrefixes(branchName))
  const nestedPrefix = `${branchName}/`
  let nestedConflict: BranchRefDirectoryConflict | null = null

  for (const line of stdout.split(/\r?\n/)) {
    const refName = line.trim()
    if (!refName.startsWith(REFS_HEADS)) {
      continue
    }
    const shortRef = refName.slice(REFS_HEADS.length)
    // A shorter ref blocking us is reported first: it is the more specific
    // finding, and unlike the nested case no suffix of `branchName` can avoid it.
    if (prefixes.has(shortRef)) {
      return { direction: 'file', existingBranch: shortRef }
    }
    if (!nestedConflict && shortRef.startsWith(nestedPrefix)) {
      nestedConflict = { direction: 'directory', existingBranch: shortRef }
    }
  }

  return nestedConflict
}

/**
 * The user-facing reason a branch name is unavailable. Shared by the local, WSL,
 * SSH, and runtime create flows so all four report a collision identically.
 *
 * `subject` names the field the user should change; the runtime create path
 * omits it and reports the bare reason.
 */
export function formatBranchConflictMessage(
  branchName: string,
  kind: BranchConflictKind,
  subject?: string
): string {
  const advice = subject ? ` Pick a different ${subject}.` : ''
  if (kind === 'local-ref-prefix') {
    // Why: no suffix escapes this one, so "pick a different name" alone is a
    // dead end — the user has to deal with the branch that is in the way.
    return `Branch "${branchName}" conflicts with an existing branch that is a prefix of it. Git cannot store both, and no suffix avoids it. Rename or delete the existing branch, or pick a different ${subject ?? 'branch name'}.`
  }
  if (kind === 'local-directory') {
    // Why: "already exists" would be a lie. No ref has this exact name; the name
    // is unusable because git cannot nest it against a ref that does exist.
    return `Branch "${branchName}" conflicts with an existing branch name in this repo. Git cannot store both.${advice}`
  }
  return `Branch "${branchName}" already exists ${kind === 'local' ? 'locally' : 'on a remote'}.${advice}`
}
