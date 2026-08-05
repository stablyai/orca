// Validates a model-requested file path against the permitted audit scope.
//
// THIS IS THE ONLY PLACE MODEL OUTPUT CAN SELECT BYTES THAT LEAVE THE MACHINE,
// which is why it is a separate, pure, exhaustively-tested module with no I/O
// beyond one realpath and one stat.
//
// FAIL-CLOSED AND NON-ITERATIVE. Every rejection returns a code the caller turns
// into a terminal `context_request_invalid` for the WHOLE audit. A rejected path
// is never merely skipped: skipping would let a model probe the filesystem one
// refused path at a time, learning the layout from which requests survive. One
// bad path ends the audit.
//
// THE CHECK ORDER IS LOAD-BEARING. Textual screens run BEFORE any filesystem
// call, so a malicious path is rejected without ever being resolved — and the
// realpath comparison runs LAST, after the cheap screens, because it is the only
// one that can follow a symlink off the machine's intended tree.
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { NO_TOOLS_LIMITS } from '../../shared/audited-audit-mode-types'

export type ScopeRejectionCode =
  | 'not_relative'
  | 'traversal'
  | 'outside_scope'
  | 'not_a_file'
  | 'too_large'
  | 'malformed'

export type ScopeResolution =
  | { ok: true; absolutePath: string; relativePath: string; byteSize: number }
  | { ok: false; rejection: ScopeRejectionCode }

/**
 * Paths that are never auditable regardless of scope.
 *
 * `.git` is excluded because it holds the object database and config — the diff
 * the model needs is supplied by main, so there is no legitimate reason to read
 * raw Git internals. The rest are the conventional homes of local credentials,
 * and a plausible-sounding request for one ("I need to see the env config to
 * audit this") must be refused structurally rather than judged case by case.
 */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.env', '.ssh', '.orca', 'node_modules'])

/** Suffixes whose contents are secret-bearing by convention. */
const FORBIDDEN_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.enc']

/**
 * Resolves one requested path inside `scopeRoot`.
 *
 * `scopeRoot` is main-supplied and is the audited worktree — never a value that
 * crossed IPC, and never widened to the source repository.
 */
export function resolveRequestedPath(scopeRoot: string, requested: unknown): ScopeResolution {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { ok: false, rejection: 'malformed' }
  }
  const candidate = requested.trim()

  // A NUL byte truncates the path at the syscall boundary, so a value like
  // "safe.ts\0../../etc/passwd" could pass a textual check and resolve to
  // something else entirely.
  if (candidate.includes('\0')) {
    return { ok: false, rejection: 'malformed' }
  }

  // Absolute in EITHER convention. isAbsolute alone is platform-dependent: on
  // POSIX it accepts "C:\\x" as relative, so a bundle built on Linux for a
  // Windows-shaped request would slip through.
  if (isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate) || /^[\\/]/.test(candidate)) {
    return { ok: false, rejection: 'not_relative' }
  }

  // UNC and Windows device namespaces, which are absolute without matching the
  // patterns above on a POSIX host.
  if (candidate.startsWith('\\\\') || /^\\\\[?.]\\/.test(candidate)) {
    return { ok: false, rejection: 'not_relative' }
  }

  const segments = candidate.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, rejection: 'traversal' }
  }
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    return { ok: false, rejection: 'outside_scope' }
  }
  const lower = candidate.toLowerCase()
  if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return { ok: false, rejection: 'outside_scope' }
  }

  const absolute = resolve(join(scopeRoot, candidate))

  // Belt-and-braces after resolution: a segment such as "a/../../b" is caught by
  // the textual screen, but resolve() is the authority on what the path became.
  if (!isWithin(scopeRoot, absolute)) {
    return { ok: false, rejection: 'outside_scope' }
  }

  let stats: ReturnType<typeof statSync>
  try {
    // lstat semantics are NOT wanted here — a symlink is followed deliberately
    // so the realpath check below sees the true target. The check that matters
    // is that the TARGET is still inside scope.
    stats = statSync(absolute)
  } catch {
    return { ok: false, rejection: 'not_a_file' }
  }
  if (!stats.isFile()) {
    return { ok: false, rejection: 'not_a_file' }
  }
  if (stats.size > NO_TOOLS_LIMITS.maxFileBytes) {
    return { ok: false, rejection: 'too_large' }
  }

  // THE SYMLINK ESCAPE. Everything above is satisfied by a symlink inside the
  // worktree that points at ~/.aws/credentials. Only comparing REAL paths
  // catches it, and both sides must be realpath'd: on macOS the worktree itself
  // commonly sits under /var -> /private/var, so comparing a real target
  // against a non-real root would reject every legitimate file.
  let realTarget: string
  let realRoot: string
  try {
    realTarget = realpathSync(absolute)
    realRoot = realpathSync(scopeRoot)
  } catch {
    return { ok: false, rejection: 'outside_scope' }
  }
  if (!isWithin(realRoot, realTarget)) {
    return { ok: false, rejection: 'outside_scope' }
  }

  return {
    ok: true,
    absolutePath: absolute,
    relativePath: segments.join('/'),
    byteSize: stats.size
  }
}

/**
 * Whether `target` is at or beneath `root`.
 *
 * Uses path.relative rather than startsWith: a raw prefix test treats
 * "/repo-secrets" as inside "/repo", which is a real containment bug and not a
 * hypothetical one.
 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === '') {
    return true
  }
  return !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export type ContextRequestValidation =
  | { ok: true; paths: readonly string[] }
  | { ok: false; rejection: ScopeRejectionCode }

/**
 * Validates the shape and size of a whole `needFiles` list before any path is
 * resolved, so an oversized request costs no filesystem work.
 */
export function validateContextRequest(requested: unknown): ContextRequestValidation {
  if (!Array.isArray(requested)) {
    return { ok: false, rejection: 'malformed' }
  }
  if (requested.length === 0 || requested.length > NO_TOOLS_LIMITS.maxRequestedFiles) {
    return { ok: false, rejection: 'malformed' }
  }
  if (!requested.every((entry) => typeof entry === 'string')) {
    return { ok: false, rejection: 'malformed' }
  }
  return { ok: true, paths: requested }
}
