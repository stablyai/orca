// The durable candidate object store (Phase 8 §0) — an app-owned, bounded,
// time-limited store of the approved candidate's Git objects.
//
// WHY IT EXISTS. Phase 7 derives a candidate under a temp GIT_OBJECT_DIRECTORY
// and deletes it, so at commit time the approved tree is ABSENT from the real
// store and `commit-tree` fails with "not a valid object". Phase 8 promotes the
// approved graph out of this store instead of re-hashing the worktree, which is
// what keeps unapproved bytes out of .git/objects.
//
// THE TRUST BOUNDARY (§0.1). This holds real source content as plaintext
// zlib-compressed Git objects, INCLUDING untracked non-ignored files, which can
// mean .env files, keys, and customer data the user never staged. Being outside
// .git prevents the repository-object leak; it does not make indefinite plaintext
// retention acceptable, which is why §0.2 bounds it and §0.3 expires it. Anyone
// who can read userData can already read the worktree, so this adds DURATION of
// exposure, not a new class of reader — bounding retention is the real control.
//
// Encryption is deliberately not used: Git must read these objects directly
// during promotion, safeStorage is credential-sized, and the key would sit on the
// same disk. It would add failure modes while buying almost nothing.
//
// Filesystem deletion does NOT securely erase bytes — blocks may persist on SSDs,
// in journals, snapshots, and backups. Deletion bounds retention and
// discoverability, nothing more.
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CANDIDATE_STORE_LIMITS, type CommitReasonCode } from '../../shared/audited-commit-types'
import type { ManifestReasonCode } from '../../shared/audited-workflow-types'
import {
  assertCandidateStoreReadShape,
  buildCatFileExistsArgv,
  buildPackObjectsStdoutArgv,
  buildRevListObjectsArgv,
  buildUnpackObjectsArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { readCommonDir } from './audited-worktree-evidence'
import { FULL_OID } from './audited-worktree-identity'

export const CANDIDATE_STORE_DIR_PATTERN = /^cand_[0-9a-f]{32}$/

export function getCandidateStoreRoot(userDataPath: string): string {
  return join(userDataPath, 'audited-workflow', 'candidate-store')
}

export function getCandidateStoreDir(userDataPath: string, candidateId: string): string {
  return join(getCandidateStoreRoot(userDataPath), candidateId)
}

/** Recursively sums file bytes. Returns 0 for a missing directory. */
export function measureDirectoryBytes(dir: string): number {
  let total = 0
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += measureDirectoryBytes(full)
      } else if (entry.isFile()) {
        total += statSync(full).size
      }
    } catch {
      // A file that vanished mid-walk contributes nothing; the total stays a
      // lower bound rather than throwing during measurement.
    }
  }
  return total
}

export type CandidateFootprint = {
  /** Uncompressed blob/tree bytes — what the per-candidate bounds judge. */
  logicalBytes: number
  /** Real on-disk object bytes — what the GLOBAL budget charges. */
  durableBytes: number
  objectCount: number
}

export type FootprintResult =
  | { ok: true; footprint: CandidateFootprint }
  | { ok: false; reasonCode: ManifestReasonCode }

/**
 * Measures what Git ACTUALLY wrote, after write-tree returned.
 *
 * This is a measurement of a completed fact, not a filesystem preflight
 * prediction: whatever Git hashed IS the candidate. A file mutated during
 * derivation simply yields a different tree OID, which the freshness gates
 * already reject — size accounting never has to guess.
 */
export async function measureCandidateFootprint(
  ephemeralStoreDir: string,
  worktreePath: string,
  treeOid: string
): Promise<FootprintResult> {
  const listed = await readObjectList(ephemeralStoreDir, worktreePath, treeOid)
  if (!listed.ok) {
    return { ok: false, reasonCode: 'file_unreadable' }
  }
  const durableBytes = measureDirectoryBytes(ephemeralStoreDir)
  let logicalBytes = 0
  for (const oid of listed.oids) {
    const size = await readObjectSize(ephemeralStoreDir, worktreePath, oid)
    if (size === null) {
      return { ok: false, reasonCode: 'file_unreadable' }
    }
    if (size > CANDIDATE_STORE_LIMITS.perFileLogicalBytes) {
      return { ok: false, reasonCode: 'untracked_file_bytes_exceeded' }
    }
    logicalBytes += size
  }
  if (logicalBytes > CANDIDATE_STORE_LIMITS.candidateGraphLogicalBytes) {
    return { ok: false, reasonCode: 'manifest_total_bytes_exceeded' }
  }
  if (listed.oids.length > CANDIDATE_STORE_LIMITS.untrackedFileCount) {
    return { ok: false, reasonCode: 'untracked_file_count_exceeded' }
  }
  return {
    ok: true,
    footprint: { logicalBytes, durableBytes, objectCount: listed.oids.length }
  }
}

type ObjectListResult = { ok: true; oids: string[] } | { ok: false }

async function readObjectList(
  storeDir: string,
  cwd: string,
  treeOid: string
): Promise<ObjectListResult> {
  const argv = buildRevListObjectsArgv(treeOid)
  assertCandidateStoreReadShape(argv, storeDir)
  const result = await runGitWithStore(argv, cwd, storeDir)
  if (!result.ok) {
    return { ok: false }
  }
  const oids = result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FULL_OID.test(line))
  return { ok: true, oids }
}

async function readObjectSize(storeDir: string, cwd: string, oid: string): Promise<number | null> {
  const result = await runGitWithStore(['cat-file', '-s', oid], cwd, storeDir)
  if (!result.ok) {
    return null
  }
  const parsed = Number.parseInt(result.stdout.toString('utf8').trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

type RawGitResult = { ok: true; stdout: Buffer } | { ok: false; error: unknown }

/**
 * Spawns Git with GIT_OBJECT_DIRECTORY pointed at an app-owned store, capturing
 * binary stdout.
 *
 * Spawned directly rather than through the shared runner because the promotion
 * round-trip needs binary stdin AND stdout together, which no existing helper
 * offers. The store dir is passed via env, never interpolated into a shell
 * string, so a path with spaces, a drive letter, or a UNC prefix is never parsed.
 */
async function runGitWithStore(
  argv: readonly string[],
  cwd: string,
  storeDir: string,
  stdin?: Buffer
): Promise<RawGitResult> {
  // The real object store, resolved through the existing common-dir reader so a
  // LINKED worktree (the audited case) resolves correctly rather than assuming
  // `<cwd>/.git/objects`.
  const commonDir = await readCommonDir(cwd)
  if (!commonDir) {
    return { ok: false, error: new Error('common dir unresolvable') }
  }
  const alternate = join(commonDir, 'objects')
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...argv],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_OBJECT_DIRECTORY: storeDir,
          // The candidate graph references base-commit objects that live only in
          // the real store, so enumeration and sizing must be able to READ it.
          // Read-only by construction: GIT_OBJECT_DIRECTORY above is where every
          // write would land, and neither rev-list nor pack-objects --stdout
          // writes at all.
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error })
          return
        }
        resolve({ ok: true, stdout: stdout as unknown as Buffer })
      }
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

export type PromotionResult = { ok: true } | { ok: false; reasonCode: CommitReasonCode }

/**
 * Phase A0.2 — promotes the approved graph into the REAL object store.
 *
 * Reads OBJECTS from the candidate store and never the working tree, so a
 * concurrently edited or newly created file cannot be included. The pack is
 * streamed through stdin/stdout buffers rather than a temp file, so no path is
 * ever parsed by Git.
 *
 * Called only AFTER the freshness gate passed in a throwaway store and a
 * reservation is held, so a partial promotion is always a subset of bytes the
 * human approved.
 */
export async function promoteApprovedGraph(args: {
  candidateStoreDir: string
  worktreePath: string
  approvedTreeOid: string
}): Promise<PromotionResult> {
  const listArgv = buildRevListObjectsArgv(args.approvedTreeOid)
  assertCandidateStoreReadShape(listArgv, args.candidateStoreDir)
  const listed = await runGitWithStore(listArgv, args.worktreePath, args.candidateStoreDir)
  if (!listed.ok) {
    return { ok: false, reasonCode: 'candidate_objects_unavailable' }
  }
  const oidList = listed.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FULL_OID.test(line))
  if (oidList.length === 0) {
    return { ok: false, reasonCode: 'candidate_objects_unavailable' }
  }

  const packArgv = buildPackObjectsStdoutArgv()
  assertCandidateStoreReadShape(packArgv, args.candidateStoreDir)
  const packed = await runGitWithStore(
    packArgv,
    args.worktreePath,
    args.candidateStoreDir,
    Buffer.from(`${oidList.join('\n')}\n`, 'utf8')
  )
  if (!packed.ok || packed.stdout.length === 0) {
    return { ok: false, reasonCode: 'promotion_failed' }
  }

  // Unpack into the REAL store. runAuditedGitCommitWrite asserts no
  // GIT_OBJECT_DIRECTORY is set — the inverse of the candidate isolation — so
  // this cannot silently land somewhere else.
  const unpacked = await runRealStoreUnpack(args.worktreePath, packed.stdout)
  if (!unpacked.ok) {
    return { ok: false, reasonCode: 'promotion_failed' }
  }
  return { ok: true }
}

function runRealStoreUnpack(cwd: string, pack: Buffer): Promise<RawGitResult> {
  const argv = buildUnpackObjectsArgv()
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...argv],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout) => {
        resolve(error ? { ok: false, error } : { ok: true, stdout: stdout as unknown as Buffer })
      }
    )
    child.stdin?.end(pack)
  })
}

/**
 * Confirms the promoted graph resolves in the REAL store (no GIT_OBJECT_DIRECTORY
 * redirection), so promotion is proven before commit-tree is attempted.
 */
export async function approvedTreeResolvesInRealStore(
  worktreePath: string,
  treeOid: string
): Promise<boolean> {
  const result = await runAuditedGitRead(buildCatFileExistsArgv(treeOid), worktreePath)
  return result.ok
}

/** Creates the per-candidate store directory with restrictive permissions. */
export function ensureCandidateStoreDir(userDataPath: string, candidateId: string): string {
  const dir = getCandidateStoreDir(userDataPath, candidateId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Best-effort removal. Callers MUST have already released the DB accounting: a
 * failure here is inert precisely because store_bytes is already NULL, so the
 * budget is free regardless and the directory becomes an orphan for the sweep.
 */
export function removeCandidateStoreDir(userDataPath: string, candidateId: string): boolean {
  try {
    rmSync(getCandidateStoreDir(userDataPath, candidateId), { recursive: true, force: true })
    return true
  } catch (error) {
    console.error('[auditedWorkflow] Candidate store cleanup failed:', error)
    return false
  }
}
