// "Move to this computer", apply step: puts a downloaded transfer's changes onto an existing local
// worktree. Idempotent, so "Apply changes again" after a partial or failed apply is safe: a patch
// already in the worktree is recognised (reverse check) and skipped, a patch that no longer applies
// is never forced (no 3-way, no conflict markers; it is kept in `unapplied/` and its paths are
// reported), untracked files never overwrite what is there, and sessions never replace local files.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CLOUD_TRANSFER_MAX_BYTES,
  CloudTransferManifestSchema,
  claudeProjectDirName
} from '../../shared/hosted-sandbox/cloud-transfer-pack'
import type { CloudTransferFinished } from '../../shared/hosted-sandbox/cloud-transfer-api'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { gunzipCapped, safeExtractTar } from './cloud-transfer-tar'
import { fileSize, installSessions, listFiles, type Prepared } from './cloud-transfer-steps'

/** Written into the transfer folder so a retry works after the app restarted. */
export const TRANSFER_STATE_FILE = 'transfer.json'

export const PersistedTransferSchema = z.object({
  manifest: CloudTransferManifestSchema,
  repoPath: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Set once an apply was attempted: the sweep keeps such folders for a retry. */
  worktreePath: z.string().min(1).optional()
})
type PersistedTransfer = z.infer<typeof PersistedTransferSchema>

export async function persistTransfer(entry: Prepared, worktreePath?: string): Promise<void> {
  const state: PersistedTransfer = {
    manifest: entry.manifest,
    repoPath: entry.repoPath,
    workspaceId: entry.workspaceId,
    ...(worktreePath ? { worktreePath } : {})
  }
  await writeFile(join(entry.dir, TRANSFER_STATE_FILE), JSON.stringify(state), { mode: 0o600 })
}

export async function loadPersistedTransfer(dir: string): Promise<Prepared | null> {
  try {
    const parsed = PersistedTransferSchema.safeParse(
      JSON.parse(await readFile(join(dir, TRANSFER_STATE_FILE), 'utf8'))
    )
    return parsed.success
      ? {
          dir,
          manifest: parsed.data.manifest,
          repoPath: parsed.data.repoPath,
          workspaceId: parsed.data.workspaceId
        }
      : null
  } catch {
    return null
  }
}

export type PatchOutcome = 'none' | 'applied' | 'already' | 'conflict'

async function gitOk(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  try {
    await gitExecFileAsync(args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
    return { ok: true, stderr: '' }
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? error.stderr : undefined
    return { ok: false, stderr: typeof stderr === 'string' ? stderr : String(error) }
  }
}

/** Paths git names in `error: patch failed: <path>:<line>` / `error: <path>: does not exist`. */
export function conflictPathsFromGitApply(stderr: string): string[] {
  const paths = new Set<string>()
  for (const line of stderr.split('\n')) {
    const failed = /^error: patch failed: (.+?):\d+$/.exec(line.trim())
    const other =
      /^error: (.+?): (?:does not exist in (?:index|working directory)|already exists in (?:index|working directory)|patch does not apply|does not match index)$/.exec(
        line.trim()
      )
    const path = failed?.[1] ?? other?.[1]
    if (path) {
      paths.add(path.slice(0, 1024))
    }
  }
  return [...paths].slice(0, 200)
}

/**
 * Applies `patch` to the worktree only if it applies cleanly; a patch whose reverse applies is
 * already there (an earlier attempt got this far). Never touches files on a conflict.
 */
export async function applyPatchIdempotent(
  worktreePath: string,
  patch: string,
  index: boolean,
  leftovers: string
): Promise<{ outcome: PatchOutcome; conflicts: string[] }> {
  if ((await fileSize(patch)) === 0) {
    return { outcome: 'none', conflicts: [] }
  }
  const flags = ['--whitespace=nowarn', ...(index ? ['--index'] : [])]
  const saved = join(leftovers, patch.split('/').at(-1)!)
  // "Already applied" for the staged patch is judged on the index alone (--cached): the worktree may
  // also carry the unstaged patch on the same files, which --index would read as "does not match".
  const reverse = ['--whitespace=nowarn', ...(index ? ['--cached'] : [])]
  if ((await gitOk(worktreePath, ['apply', '--check', '-R', ...reverse, patch])).ok) {
    await rm(saved, { force: true })
    return { outcome: 'already', conflicts: [] }
  }
  const check = await gitOk(worktreePath, ['apply', '--check', ...flags, patch])
  if (check.ok && (await gitOk(worktreePath, ['apply', ...flags, patch])).ok) {
    await rm(saved, { force: true })
    return { outcome: 'applied', conflicts: [] }
  }
  // Keep the user's work even if it no longer applies (e.g. they edited those files since).
  await mkdir(leftovers, { recursive: true })
  await cp(patch, saved)
  return { outcome: 'conflict', conflicts: conflictPathsFromGitApply(check.stderr) }
}

/** Applies a downloaded transfer to `worktreePath`; safe to run again on the same worktree. */
export async function applyTransferToWorktree(
  entry: Prepared,
  worktreePath: string,
  homes: { claudeHome: string; codexHome: string }
): Promise<CloudTransferFinished> {
  await persistTransfer(entry, worktreePath)
  const leftovers = join(entry.dir, 'unapplied')
  const staged = await applyPatchIdempotent(
    worktreePath,
    join(entry.dir, 'staged.patch'),
    true,
    leftovers
  )
  const unstaged = await applyPatchIdempotent(
    worktreePath,
    join(entry.dir, 'unstaged.patch'),
    false,
    leftovers
  )
  let skippedUntracked: string[] = []
  if ((await fileSize(join(entry.dir, 'untracked.tgz'))) > 0) {
    // Inflate with a cap (no gzip bombs), then extract without clobbering anything already there.
    const untrackedTar = join(entry.dir, 'untracked.tar')
    await gunzipCapped(join(entry.dir, 'untracked.tgz'), untrackedTar, CLOUD_TRANSFER_MAX_BYTES)
    const extracted = await safeExtractTar(untrackedTar, worktreePath, {
      maxBytes: CLOUD_TRANSFER_MAX_BYTES,
      noClobber: true
    })
    await rm(untrackedTar, { force: true })
    // Files that differ from what is here were not written: keep the archive and name them, so
    // nothing is lost and the folder (and "Apply changes again") stays.
    skippedUntracked = [...extracted.existing, ...extracted.skipped].slice(0, 200)
    if (extracted.existing.length > 0) {
      await mkdir(leftovers, { recursive: true })
      await cp(join(entry.dir, 'untracked.tgz'), join(leftovers, 'untracked.tgz'))
      await writeFile(
        join(leftovers, 'untracked-not-written.txt'),
        `${extracted.existing.join('\n')}\n`
      )
    } else {
      await rm(join(leftovers, 'untracked.tgz'), { force: true })
      await rm(join(leftovers, 'untracked-not-written.txt'), { force: true })
    }
  }
  const claudeSessions = await installSessions(
    join(entry.dir, 'claude'),
    join(homes.claudeHome, 'projects', claudeProjectDirName(worktreePath)),
    entry.manifest.root,
    worktreePath
  )
  const codexSessions = await installSessions(
    join(entry.dir, 'codex'),
    join(homes.codexHome, 'sessions'),
    entry.manifest.root,
    worktreePath
  )
  const kept = (await listFiles(leftovers)).length > 0
  if (!kept) {
    await rm(entry.dir, { recursive: true, force: true })
  }
  return {
    worktreePath,
    appliedStaged: staged.outcome === 'applied' || staged.outcome === 'already',
    appliedUnstaged: unstaged.outcome === 'applied' || unstaged.outcome === 'already',
    untrackedFiles: entry.manifest.untrackedFiles,
    claudeSessions,
    codexSessions,
    leftoverPatchDir: kept ? leftovers : null,
    conflicts: [...staged.conflicts, ...unstaged.conflicts],
    skippedUntracked
  }
}
