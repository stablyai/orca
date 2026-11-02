// .orca/issue-command is local; orca.yaml supplies the tracked project default.
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadHooks } from './hooks'
import type { GitRuntimeOptions } from './git/git-runtime-options'
import { checkIgnoredPaths } from './git/check-ignored-paths'
import {
  guardWslUncPathAccess,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from './wsl/wsl-unc-access-gate'

type IssueCommandGitOptions = GitRuntimeOptions | (() => GitRuntimeOptions)

const ORCA_DIR = '.orca'
const ISSUE_COMMAND_FILENAME = 'issue-command'

export function getIssueCommandFilePath(repoPath: string): string {
  return join(repoPath, ORCA_DIR, ISSUE_COMMAND_FILENAME)
}

export function getSharedIssueCommand(repoPath: string): string | null {
  return loadHooks(repoPath)?.issueCommand?.trim() || null
}

export type ResolvedIssueCommand = {
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

export function readIssueCommand(repoPath: string): ResolvedIssueCommand {
  const filePath = getIssueCommandFilePath(repoPath)
  let localContent: string | null = null

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      localContent = content || null
    } catch {
      localContent = null
    }
  }

  const sharedContent = getSharedIssueCommand(repoPath)
  const effectiveContent = localContent ?? sharedContent

  return {
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath: filePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

/**
 * `readIssueCommand` that never starts a stopped WSL distro for a background read (E9): its
 * `\\wsl.localhost` touch is refused with the unreachable result. `wakeWslDistro` is a launch, a
 * user act that may start it.
 */
export async function readIssueCommandUnlessWslStopped(
  repoPath: string,
  options: { wakeWslDistro?: boolean } = {}
): Promise<ResolvedIssueCommand & { status?: 'error'; refusedWslDistro?: string }> {
  try {
    return await guardWslUncPathAccess(repoPath, async () => readIssueCommand(repoPath), {
      wake: options.wakeWslDistro === true
    })
  } catch (error) {
    if (error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError) {
      return {
        status: 'error',
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: getIssueCommandFilePath(repoPath),
        source: 'none',
        // Names the distro so the editor can stay read-only and re-read once it runs.
        refusedWslDistro: error.distro
      }
    }
    throw error
  }
}

/**
 * `writeIssueCommand` that refuses a stopped WSL distro's repo unless the user is saving their own
 * edit (`wakeWslDistro`): a write the user never made must not start it or replace a hidden file.
 */
export async function writeIssueCommandUnlessWslStopped(
  repoPath: string,
  content: string,
  gitOptions: IssueCommandGitOptions,
  options: { wakeWslDistro?: boolean } = {}
): Promise<void> {
  await guardWslUncPathAccess(repoPath, () => writeIssueCommand(repoPath, content, gitOptions), {
    wake: options.wakeWslDistro === true,
    // A host-path repo whose Git runs in WSL starts the distro through the ignore check a save
    // runs; clearing runs no Git, so it leaves the options unresolved.
    wslDistro: content.trim() ? gitWslDistro(gitOptions) : undefined
  })
}

function gitWslDistro(gitOptions: IssueCommandGitOptions): string | undefined {
  try {
    return (typeof gitOptions === 'function' ? gitOptions() : gitOptions).wslDistro
  } catch {
    // A runtime awaiting repair resolves no Git distro; the path still gates UNC repos.
    return undefined
  }
}

/** Empty content removes the local override so the shared orca.yaml command applies. */
export async function writeIssueCommand(
  repoPath: string,
  content: string,
  options: IssueCommandGitOptions = {}
): Promise<void> {
  const filePath = getIssueCommandFilePath(repoPath)
  const trimmed = content.trim()

  try {
    if (!trimmed) {
      rmSync(filePath, { force: true })
      return
    }

    const orcaDir = join(repoPath, ORCA_DIR)
    if (!existsSync(orcaDir)) {
      mkdirSync(orcaDir, { recursive: true })
    }
    if (!(await isIssueCommandIgnoredByGit(repoPath, options))) {
      ensureOrcaDirIgnored(repoPath)
    }
    writeFileSync(filePath, `${trimmed}\n`, 'utf-8')
  } catch (err) {
    console.error('[hooks] Failed to write issue command:', err)
    throw err
  }
}

/** Consult Git before changing shared ignore rules for a private override. */
async function isIssueCommandIgnoredByGit(
  repoPath: string,
  options: IssueCommandGitOptions = {}
): Promise<boolean> {
  try {
    const issueCommandPath = `${ORCA_DIR}/${ISSUE_COMMAND_FILENAME}`
    const ignored = await checkIgnoredPaths(
      repoPath,
      [issueCommandPath],
      // Runtime repair must not block saving or clearing the local override.
      typeof options === 'function' ? options() : options
    )
    return ignored.includes(issueCommandPath)
  } catch {
    // Preserve the existing ignore-file fallback if Git cannot inspect the rules.
    return false
  }
}

function ensureOrcaDirIgnored(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore')
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (/^\.orca\/?$/m.test(content)) {
        return
      }
      const separator = content.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, `${content}${separator}.orca\n`, 'utf-8')
    } else {
      writeFileSync(gitignorePath, '.orca\n', 'utf-8')
    }
  } catch {
    console.warn('[hooks] Could not update .gitignore to exclude .orca')
  }
}
