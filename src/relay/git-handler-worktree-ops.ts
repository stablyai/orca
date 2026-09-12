import * as path from 'node:path'
import {
  GIT_PUSH_SET_UPSTREAM_GUIDANCE,
  isPushAutoSetupRemoteApplicable,
  supportsPushAutoSetupRemote,
  type GitCapabilityCache
} from '../shared/git-capability-cache'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'
import { windowsLongPathGitArgs } from '../shared/windows-long-path-git-args'
import type { GitExec } from './git-handler-ops'
export { removeWorktreeOp } from './git-handler-worktree-remove'
export { readRelayWorktreeList } from './git-handler-worktree-list'

async function persistRelayWorktreeCreationBase(
  git: GitExec,
  targetDir: string,
  branchName: string,
  effectiveBase: string
): Promise<void> {
  const configKey = `branch.${branchName}.base`
  try {
    await git(['config', '--local', '--replace-all', configKey, effectiveBase], targetDir)
  } catch (error) {
    console.warn(`relay addWorktree: failed to set ${configKey} for ${targetDir}`, error)
    try {
      // Why: SSH worktree creation shares branch config by name; clear stale
      // metadata if replacing an old same-name base fails.
      await git(['config', '--local', '--unset-all', configKey], targetDir)
    } catch (unsetError) {
      console.warn(
        `relay addWorktree: failed to unset stale ${configKey} for ${targetDir}`,
        unsetError
      )
    }
  }
}

export async function addWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache,
  // Why: only the execution host's OS matters here — the client may be macOS while the SSH host is Windows.
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const repoPath = params.repoPath as string
  const branchName = params.branchName as string
  const targetDir = params.targetDir as string
  const base = params.base as string | undefined
  const checkoutExistingBranch = params.checkoutExistingBranch === true
  const noCheckout = params.noCheckout === true

  // Why: a branchName starting with '-' would be interpreted as a git flag,
  // potentially changing the command's semantics (e.g. "--detach").
  if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
    throw new Error('Branch name and base ref must not start with "-"')
  }

  // Why: --no-track + push.autoSetupRemote=true mirrors the local
  // addWorktree path (src/main/git/worktree.ts). Keeping the SSH path in
  // sync prevents a transport-only divergence where "Orca creates a
  // worktree" produces a different `git status` / `git push` UX based on
  // whether the repo is local or SSH-mounted. See full design rationale
  // (state machine, common-dir scope, old-git fallback) in the comments
  // around src/main/git/worktree.ts addWorktree — those invariants apply
  // identically here.
  const effectiveBase =
    base && !checkoutExistingBranch
      ? await resolveWorktreeAddBaseRef(base, async (qualifiedRef) => {
          try {
            await git(['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`], repoPath)
            return true
          } catch {
            return false
          }
        })
      : undefined

  // Why: a Windows SSH host hits the same MAX_PATH ceiling as a local Windows checkout.
  const longPathArgs = windowsLongPathGitArgs(targetDir, platform)
  const args = checkoutExistingBranch
    ? [...longPathArgs, 'worktree', 'add', targetDir, branchName]
    : [...longPathArgs, 'worktree', 'add', '--no-track', '-b', branchName, targetDir]
  if (!checkoutExistingBranch && noCheckout) {
    // Why: offset by the global-option prefix so --no-checkout still lands before -b.
    args.splice(longPathArgs.length + 3, 0, '--no-checkout')
  }
  if (effectiveBase) {
    args.push(effectiveBase)
  }

  await git(args, repoPath)

  if (checkoutExistingBranch) {
    // Why: a claimed branch skips branch.<name>.base (it is not a new
    // branch) but still needs autoSetupRemote, or its first push fails
    // with no upstream — mirrors local addWorktree's claim path.
    await ensureRelayPushAutoSetupRemote(git, targetDir, capabilities)
    return
  }

  if (effectiveBase) {
    await persistRelayWorktreeCreationBase(git, targetDir, branchName, effectiveBase)
  }

  await ensureRelayPushAutoSetupRemote(git, targetDir, capabilities)
}

// Why: preserve any user value; unsupported remote Git gets explicit first-push guidance.
async function ensureRelayPushAutoSetupRemote(
  git: GitExec,
  targetDir: string,
  capabilities: GitCapabilityCache
): Promise<void> {
  try {
    let alreadySet = false
    try {
      await git(['config', '--get', 'push.autoSetupRemote'], targetDir)
      alreadySet = true
    } catch (readError) {
      // Why: `git config --get` exits 1 only when the key is unset at every
      // scope. Any other code is a real read failure (corrupt config,
      // locked file) — surface it via the outer catch instead of falling
      // through to overwrite the user's actual value.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      let pushDefault: string | undefined
      try {
        const { stdout } = await git(['config', '--get', 'push.default'], targetDir)
        pushDefault = stdout
      } catch (readError) {
        const code = (readError as { code?: unknown })?.code
        if (code !== 1) {
          throw readError
        }
      }
      if (!isPushAutoSetupRemoteApplicable(pushDefault)) {
        console.warn(
          `relay addWorktree: push.default does not support automatic upstream setup; first push requires: ${GIT_PUSH_SET_UPSTREAM_GUIDANCE}`
        )
        return
      }
      const supported = await supportsPushAutoSetupRemote(capabilities, async () => {
        const { stdout } = await git(['help', '--config'], targetDir)
        return stdout
      })
      if (!supported) {
        console.warn(
          `relay addWorktree: Git does not support push.autoSetupRemote; first push requires: ${GIT_PUSH_SET_UPSTREAM_GUIDANCE}`
        )
        return
      }
      await git(['config', '--local', 'push.autoSetupRemote', 'true'], targetDir)
    }
  } catch (error) {
    console.warn(`relay addWorktree: failed to set push.autoSetupRemote for ${targetDir}`, error)
  }
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizeRelayWorktreePathForCompare(value: string): string {
  if (isPosixAbsolutePath(value)) {
    return path.posix.normalize(path.posix.resolve(value))
  }
  if (isWindowsAbsolutePath(value)) {
    return path.win32.normalize(path.win32.resolve(value))
  }
  return path.normalize(path.resolve(value))
}

export function areRelayWorktreePathsEqual(leftPath: string, rightPath: string): boolean {
  const left = normalizeRelayWorktreePathForCompare(leftPath)
  const right = normalizeRelayWorktreePathForCompare(rightPath)
  const compareCaseInsensitive = isWindowsAbsolutePath(leftPath) && isWindowsAbsolutePath(rightPath)
  return compareCaseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function worktreeIsCleanOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<{ clean: boolean; stdout?: string }> {
  const worktreePath = params.worktreePath as string
  const includeUntracked = params.includeUntracked !== false
  const { stdout } = await git(
    ['status', '--porcelain', includeUntracked ? '--untracked-files=all' : '--untracked-files=no'],
    worktreePath
  )
  const clean = !stdout.trim()
  return { clean, stdout: clean ? undefined : stdout }
}

export async function commitChangesRelay(
  git: GitExec,
  worktreePath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  // Why: defense-in-depth. The IPC handler at src/main/ipc/filesystem.ts validates
  // the message, but a relay caller (future automation, or an SSH client connecting
  // to the relay directly) could bypass that path. Reject empty/whitespace messages
  // here so we surface a clear error instead of git's opaque failure.
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { success: false, error: 'Commit message is required' }
  }

  try {
    await git(['commit', '-m', message], worktreePath)
    return { success: true }
  } catch (error) {
    // Why: surface whichever channel carries the useful message. Pre-commit/GPG
    // hook failures write to stderr; "nothing to commit, working tree clean"
    // writes to stdout. Try stderr first, fall back to stdout, then error.message.
    // Mirrors commitChanges in src/main/git/status.ts — keep the two paths in sync.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  }
}
