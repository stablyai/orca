// Why: `.orca/issue-command` is the per-user override; `orca.yaml` is the tracked project default.
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadHooks } from './hooks'
import type { GitRuntimeOptions } from './git/git-runtime-options'
import { checkIgnoredPaths } from './git/check-ignored-paths'
import { requireSshGitProvider } from './providers/ssh-git-dispatch'
import { REPO_COMMAND_YAML_KEY, type RepoCommandKind } from '../shared/repo-command-kind'

type IssueCommandGitOptions = GitRuntimeOptions | (() => GitRuntimeOptions)

const ORCA_DIR = '.orca'
const REPO_COMMAND_FILENAME: Record<RepoCommandKind, string> = {
  issue: 'issue-command',
  review: 'review-command'
}

export function getRepoCommandRelativePath(kind: RepoCommandKind): string {
  return `${ORCA_DIR}/${REPO_COMMAND_FILENAME[kind]}`
}

export function getIssueCommandFilePath(repoPath: string, kind: RepoCommandKind = 'issue'): string {
  return join(repoPath, ORCA_DIR, REPO_COMMAND_FILENAME[kind])
}

export function getSharedIssueCommand(
  repoPath: string,
  kind: RepoCommandKind = 'issue'
): string | null {
  return loadHooks(repoPath)?.[REPO_COMMAND_YAML_KEY[kind]]?.trim() || null
}

export type ResolvedIssueCommand = {
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/**
 * Resolve the GitHub issue command using local override first, then tracked repo config.
 */
export function readIssueCommand(
  repoPath: string,
  kind: RepoCommandKind = 'issue'
): ResolvedIssueCommand {
  const filePath = getIssueCommandFilePath(repoPath, kind)
  let localContent: string | null = null

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      localContent = content || null
    } catch {
      localContent = null
    }
  }

  const sharedContent = getSharedIssueCommand(repoPath, kind)
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
 * Write the per-user issue command override to `{repoRoot}/.orca/issue-command`.
 * Empty content deletes the override so the shared `orca.yaml` command applies again.
 */
export async function writeIssueCommand(
  repoPath: string,
  content: string,
  options: IssueCommandGitOptions = {},
  kind: RepoCommandKind = 'issue'
): Promise<void> {
  const filePath = getIssueCommandFilePath(repoPath, kind)
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
    if (!(await isIssueCommandIgnoredByGit(repoPath, undefined, options, kind))) {
      ensureOrcaDirIgnored(repoPath)
    }
    writeFileSync(filePath, `${trimmed}\n`, 'utf-8')
  } catch (err) {
    console.error(`[hooks] Failed to write ${kind} command:`, err)
    // Why: re-throw so the IPC handler surfaces the write failure to the renderer's .catch().
    throw err
  }
}

/** Consult the execution host before changing shared ignore rules for a private override. */
export async function isIssueCommandIgnoredByGit(
  repoPath: string,
  connectionId?: string,
  options: IssueCommandGitOptions = {},
  kind: RepoCommandKind = 'issue'
): Promise<boolean> {
  try {
    const issueCommandPath = getRepoCommandRelativePath(kind)
    const ignored = connectionId
      ? await requireSshGitProvider(connectionId).checkIgnoredPaths(repoPath, [issueCommandPath])
      : await checkIgnoredPaths(
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

/** Ensure `.orca` is in `.gitignore` so the per-user directory is never committed. */
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
