// Sanitization and on-disk storage for the immutable plan artifact (Phase 5).
//
// REDACTION IS BEST-EFFORT — read this before relying on it.
// This is the same disclaimer audited-claude-launch-plan.ts carries about its
// Git denylist, for the same reason. A model can describe a path or a secret in
// prose, split it across lines, or paraphrase it; no pattern set closes that.
// The AUTHORITATIVE protections are structural: (1) plan text never reaches
// mobile/RPC — the feature is Electron-IPC-only; (2) the plan body is never
// attached to a projection (AUDITED_PROJECTION_FORBIDDEN_KEYS enforces it at
// runtime); (3) the body crosses only on an explicit, task-scoped
// getPlanArtifact call. Redaction reduces incidental leakage in a body the human
// deliberately asked to see — it is not a containment boundary.
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  fsyncSync
} from 'node:fs'
import { join } from 'node:path'
import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { boundExecutionStream } from './audited-execution-output-store'

// Plans are prose, not logs: 256KB is far above any real plan while still
// bounding a runaway generation. Larger input is head+tail bounded, never dropped.
export const MAX_PLAN_ARTIFACT_CHARS = 256 * 1024

// The bound applied to the model-authored review summary BEFORE it is stored,
// because it is the one free-text field that later reaches the renderer.
export const MAX_REVIEW_SUMMARY_CHARS = 4 * 1024

// Built from a char code rather than written literally: a NUL in source is
// invisible and trips no-control-regex.
const NUL = String.fromCharCode(0)

const REDACTED_PATH = '\u2039path\u203a'
const REDACTED_BRANCH = '\u2039branch\u203a'
const REDACTED_SECRET = '\u2039redacted\u203a'

export type PlanSanitizationContext = {
  // Literal values redacted by exact substring match, never guessed by regex.
  // Passed in from main because only main knows them.
  worktreePath?: string | null
  sourceRepoPath?: string | null
  sourceRepoCommonDir?: string | null
  branchName?: string | null
  userDataPath?: string | null
  homePath?: string | null
}

export type PlanSanitizationResult = {
  text: string
  redactionCount: number
  truncated: boolean
}

// High-entropy credential shapes. Ordered longest-prefix-first so a more
// specific token (github_pat_) is not partially consumed by a looser one.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,64}PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g
]

// Absolute-path shapes that survive after the literal context values are gone.
const PATH_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z]:\\Users\\[^\s"'<>|]+/g,
  /\/(?:Users|home)\/[^\s"'<>|:]+/g
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces every occurrence of `needle`, counting hits. Windows paths appear in
 * both separator forms in agent output (a shell echoes `C:\a\b`, a JSON blob
 * emits `C:\\a\\b`, a POSIX-ish tool prints `C:/a/b`), so each literal is
 * matched in all three spellings — a single-form match would leak the others.
 */
function redactLiteral(
  value: string,
  needle: string | null | undefined,
  replacement: string
): { text: string; count: number } {
  if (typeof needle !== 'string' || needle.trim().length < 3) {
    return { text: value, count: 0 }
  }
  const spellings = new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\\/g, '\\\\')])
  let text = value
  let count = 0
  for (const spelling of spellings) {
    const pattern = new RegExp(escapeRegExp(spelling), 'gi')
    text = text.replace(pattern, () => {
      count += 1
      return replacement
    })
  }
  return { text, count }
}

function redactPatterns(
  value: string,
  patterns: readonly RegExp[],
  replacement: string
): { text: string; count: number } {
  let text = value
  let count = 0
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      count += 1
      return replacement
    })
  }
  return { text, count }
}

/**
 * Sanitizes and bounds a raw plan.
 *
 * Ordering is load-bearing: secrets first (a token embedded in a URL inside a
 * path would otherwise be half-consumed by path redaction), then the caller's
 * literal identity values, then generic path shapes for anything left.
 */
export function sanitizePlanText(
  raw: string,
  context: PlanSanitizationContext = {}
): PlanSanitizationResult {
  let text = stripAnsiControlSequences(raw)
  // NUL would truncate the file for any C-string reader; CRLF normalization
  // keeps the stored hash stable across platforms. Escapes, not literal control
  // characters, so the source stays readable and lint-clean.
  text = text.split(NUL).join('').replace(/\r\n/g, '\n')

  let redactionCount = 0

  const secrets = redactPatterns(text, SECRET_PATTERNS, REDACTED_SECRET)
  text = secrets.text
  redactionCount += secrets.count

  // Longest first: the common dir and worktree path often share a prefix, and
  // redacting the shorter one first would strand the remainder of the longer.
  const literals: [string | null | undefined, string][] = [
    [context.sourceRepoCommonDir, REDACTED_PATH],
    [context.worktreePath, REDACTED_PATH],
    [context.sourceRepoPath, REDACTED_PATH],
    [context.userDataPath, REDACTED_PATH],
    [context.homePath, REDACTED_PATH],
    [context.branchName, REDACTED_BRANCH]
  ]
  literals.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))
  for (const [needle, replacement] of literals) {
    const result = redactLiteral(text, needle, replacement)
    text = result.text
    redactionCount += result.count
  }

  const paths = redactPatterns(text, PATH_PATTERNS, REDACTED_PATH)
  text = paths.text
  redactionCount += paths.count

  const bounded = boundExecutionStream(text)
  const withinCap =
    bounded.text.length <= MAX_PLAN_ARTIFACT_CHARS
      ? { text: bounded.text, truncated: bounded.truncated }
      : { text: bounded.text.slice(0, MAX_PLAN_ARTIFACT_CHARS), truncated: true }

  return { text: withinCap.text, redactionCount, truncated: withinCap.truncated }
}

/** Sanitizes and bounds a model-authored review summary before it is stored. */
export function sanitizeReviewSummary(raw: string, context: PlanSanitizationContext = {}): string {
  const sanitized = sanitizePlanText(raw, context)
  const collapsed = sanitized.text.trim()
  return collapsed.length <= MAX_REVIEW_SUMMARY_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_REVIEW_SUMMARY_CHARS - 1)}\u2026`
}

export function getPlanArtifactDir(userDataPath: string, artifactId: string): string {
  return join(userDataPath, 'audited-workflow', 'plans', artifactId)
}

export function getPlanArtifactFilePath(userDataPath: string, artifactId: string): string {
  return join(getPlanArtifactDir(userDataPath, artifactId), 'plan.md')
}

export function hashPlanText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export type PlanArtifactWriteResult =
  | { ok: true; sha256: string; charCount: number }
  | { ok: false }

/**
 * Writes the artifact body durably: temp file -> fsync -> atomic rename.
 *
 * The rename is the moment the content becomes visible under its final,
 * immutable name. A crash before it leaves only a .tmp; a crash after it (but
 * before the DB commit) leaves an orphan final file with no row, which
 * audited-plan-artifact-gc.ts reclaims. This CANNOT be made atomic with the
 * SQLite write — they are separate commit domains — so the ordering plus GC is
 * the design, not a workaround.
 *
 * Returns ok:false rather than throwing: the caller must finalize the execution
 * run truthfully either way, and an exception here would strand a running row.
 */
export function writePlanArtifactFileAtomically(
  userDataPath: string,
  artifactId: string,
  text: string
): PlanArtifactWriteResult {
  const dir = getPlanArtifactDir(userDataPath, artifactId)
  const finalPath = getPlanArtifactFilePath(userDataPath, artifactId)
  const tempPath = join(dir, '.plan.md.tmp')

  try {
    mkdirSync(dir, { recursive: true })
    const handle = openSync(tempPath, 'w')
    try {
      writeSync(handle, text, null, 'utf8')
      // Without the fsync the rename can be durable while the CONTENT is not,
      // producing a committed pointer to an empty or partial file after a crash.
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(tempPath, finalPath)
    return { ok: true, sha256: hashPlanText(text), charCount: text.length }
  } catch (error) {
    console.error('[auditedWorkflow] Writing the plan artifact failed:', error)
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // A leftover temp file is reclaimed by startup GC; nothing depends on it.
    }
    return { ok: false }
  }
}

/** Whether the immutable final file exists. Never throws. */
export function planArtifactFileExists(userDataPath: string, artifactId: string): boolean {
  try {
    return statSync(getPlanArtifactFilePath(userDataPath, artifactId)).isFile()
  } catch {
    return false
  }
}

/**
 * Reads the sanitized body. Returns null on ANY failure — a missing file, a
 * permission error, a directory in its place — so no path or errno can escape
 * to a caller that might forward it.
 */
export function readPlanArtifactFile(userDataPath: string, artifactId: string): string | null {
  try {
    return readFileSync(getPlanArtifactFilePath(userDataPath, artifactId), 'utf8')
  } catch (error) {
    console.error('[auditedWorkflow] Reading the plan artifact failed:', error)
    return null
  }
}

export type VerifiedPlanArtifactRead =
  | { ok: true; text: string }
  // The file is gone, unreadable, or larger than any plan we ever wrote.
  | { ok: false; reasonCode: 'artifact_unavailable' }
  // The file exists but its bytes are NOT the bytes the artifact row records.
  | { ok: false; reasonCode: 'artifact_superseded' }

/**
 * Reads the artifact body and proves it is EXACTLY the bytes the durable row
 * committed to.
 *
 * The artifact row's content_sha256 is the identity that every downstream
 * authorization hangs off: the admission CAS, the finalize freshness check, and
 * approvePlan all compare against it. But the row only ever described the file —
 * nothing re-verified that the file still matches. An edited plan.md would
 * therefore be reviewed by Codex, or shown to the human, while the hash-based
 * guards all still agreed. This closes that gap by making "the bytes" and "the
 * hash" the same claim at every read.
 *
 * A size check precedes hashing so a tampered file cannot force an unbounded
 * read just to be rejected.
 */
export function readVerifiedPlanArtifact(
  userDataPath: string,
  artifactId: string,
  expectedSha256: string
): VerifiedPlanArtifactRead {
  let text: string
  try {
    const path = getPlanArtifactFilePath(userDataPath, artifactId)
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_PLAN_ARTIFACT_FILE_BYTES) {
      return { ok: false, reasonCode: 'artifact_unavailable' }
    }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error('[auditedWorkflow] Reading the plan artifact failed:', error)
    return { ok: false, reasonCode: 'artifact_unavailable' }
  }

  if (hashPlanText(text) !== expectedSha256) {
    // Distinct from `artifact_unavailable`: the file is readable, it simply is
    // not the reviewed artifact any more.
    return { ok: false, reasonCode: 'artifact_superseded' }
  }
  return { ok: true, text }
}

// A generous ceiling on the FILE, independent of MAX_PLAN_ARTIFACT_CHARS: UTF-8
// can use several bytes per character, so this bounds the read without
// rejecting a legitimately large plan.
export const MAX_PLAN_ARTIFACT_FILE_BYTES = MAX_PLAN_ARTIFACT_CHARS * 4

/**
 * Test seam only: writes a body without the temp/rename dance so a suite can
 * stage an artifact file directly. Never used by production paths.
 */
export function writePlanArtifactFileForTests(
  userDataPath: string,
  artifactId: string,
  text: string
): void {
  const dir = getPlanArtifactDir(userDataPath, artifactId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(getPlanArtifactFilePath(userDataPath, artifactId), text, 'utf8')
}
