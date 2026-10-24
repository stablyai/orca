import { resolve, relative, isAbsolute, posix, sep, win32 } from 'node:path'
import type { GlobalSettings, OrcaWorkspaceLayout } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { isWindowsAbsolutePathLike, resolveRuntimePath } from '../../shared/cross-platform-path'
import { isWslUncPath, resolveWslRepoWorktreeBasePath } from '../../shared/wsl-paths'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  replaceKnownEmojiWithShortcodes,
  setEmojiShortcodeDatasetLoader
} from '../../shared/emoji-shortcode-catalog'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'
import { getWslHome, getWslHomeAsync, parseWslPath } from '../wsl'

setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

type WorktreePathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  /** Mirror Windows-drive repo worktrees into this project runtime's WSL distro; omitted retains default placement. */
  wslMirrorDistro?: string
}
type WorktreeBasePathRepo = Pick<Repo, 'path' | 'worktreeBasePath'>

export function sanitizeWorktreeName(input: string): string {
  // Preserve Unicode letters/numbers: Git permits them and workspace names must support users' languages.
  const sanitized = replaceKnownEmojiWithShortcodes(input)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    // Git rejects internal .. even after path separators are slugified.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized && containsEmoji(input)) {
    return 'workspace'
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

function containsEmoji(input: string): boolean {
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(
    input
  )
}

export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
}

/** Keep WSL worktrees on the distro filesystem to avoid cross-filesystem I/O and Windows-shell startup. */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings,
  workspaceRoot?: string
): string {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    workspaceRoot ?? computeWorkspaceRoot(repoPath, settings),
    settings.nestWorkspaces
  )
}

function computeWorktreePathFromWorkspaceRoot(
  sanitizedName: string,
  repoPath: string,
  workspaceRoot: string,
  nestWorkspaces: boolean
): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceRoot)
  if (nestWorkspaces) {
    const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
    return pathOps.join(workspaceRoot, repoName, sanitizedName)
  }
  return pathOps.join(workspaceRoot, sanitizedName)
}

/** Resolve WSL home asynchronously so a stopped distro cannot block main. */
export async function computeWorktreePathAsync(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings
): Promise<string> {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    await computeWorkspaceRootAsync(repoPath, settings),
    settings.nestWorkspaces
  )
}

/** Async WSL home probes avoid blocking main; synchronous callers retain the matching resolver below. */
export async function computeWorkspaceRootAsync(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): Promise<string> {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return workspaceRootForMirrorHome(
    repoPath,
    settings.workspaceDir,
    distro ? await getWslHomeAsync(distro) : null
  )
}

export function computeWorkspaceRoot(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): string {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return workspaceRootForMirrorHome(
    repoPath,
    settings.workspaceDir,
    distro ? getWslHome(distro) : null
  )
}

function mirrorDistroForWorkspaceRoot(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): string | undefined {
  const distro = resolveMirrorDistro(repoPath, settings)
  return distro && shouldMirrorWorkspaceDirInsideWsl(repoPath, settings.workspaceDir)
    ? distro
    : undefined
}

function workspaceRootForMirrorHome(
  repoPath: string,
  workspaceDir: string,
  wslHome: string | null
): string {
  // Desktop absolute roots must mirror into WSL; repo-relative roots already resolve inside the distro.
  return wslHome
    ? win32.join(wslHome, 'orca', 'workspaces')
    : resolveWorkspaceDirForRepo(repoPath, workspaceDir)
}

export function computeRemoteWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings,
  options: { useConfiguredAbsolutePath?: boolean } = {}
): string {
  if (
    options.useConfiguredAbsolutePath ||
    isWorkspaceDirRelativeToRepo(repoPath, settings.workspaceDir)
  ) {
    return computeWorktreePath(sanitizedName, repoPath, settings)
  }
  // Desktop absolute roots cannot apply to SSH hosts; qualify sibling paths per repo.
  const pathOps = getRuntimePathOps(repoPath, repoPath)
  const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
  return pathOps.join(repoPath, '..', `${repoName}-${sanitizedName}`)
}

export function getWorktreePathSettings(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings,
  wslMirrorDistro?: string
): WorktreePathSettings {
  return {
    nestWorkspaces: settings.nestWorkspaces,
    workspaceDir: getEffectiveWorktreeBasePath(repo, settings),
    // Resolve distro once at the store boundary so create, authorization and watch placement agree.
    ...(wslMirrorDistro ? { wslMirrorDistro } : {})
  }
}

export function getWorktreeCreationLayout(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings
): OrcaWorkspaceLayout {
  return {
    path: getEffectiveWorktreeBasePath(repo, settings),
    nestWorkspaces: settings.nestWorkspaces
  }
}

export function hasRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): boolean {
  return getRepoWorktreeBasePath(repo) !== undefined
}

function getRuntimePathOps(
  repoPath: string,
  workspaceDir: string
): Pick<typeof posix, 'basename' | 'isAbsolute' | 'join' | 'normalize'> {
  return isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(workspaceDir)
    ? win32
    : posix
}

function resolveWorkspaceDirForRepo(repoPath: string, workspaceDir: string): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceDir)
  return pathOps.isAbsolute(workspaceDir)
    ? pathOps.normalize(workspaceDir)
    : resolveRuntimePath(repoPath, workspaceDir)
}

function isWorkspaceDirRelativeToRepo(repoPath: string, workspaceDir: string): boolean {
  return !getRuntimePathOps(repoPath, workspaceDir).isAbsolute(workspaceDir)
}

function getEffectiveWorktreeBasePath(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings
): string {
  const basePath = getRepoWorktreeBasePath(repo)
  if (basePath === undefined) {
    return settings.workspaceDir
  }
  return resolveWslRepoWorktreeBasePath(repo.path, basePath)
}

function getRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): string | undefined {
  const trimmed = repo.worktreeBasePath?.trim()
  return trimmed || undefined
}

/** Prefer WSL filesystem for WSL-owned repos or Windows-drive repos executed by WSL Git, avoiding slow 9p stats. */
function resolveMirrorDistro(
  repoPath: string,
  settings: { wslMirrorDistro?: string }
): string | undefined {
  const wsl = parseWslPath(repoPath)
  if (wsl) {
    return wsl.distro
  }
  return isWindowsAbsolutePathLike(repoPath) ? settings.wslMirrorDistro : undefined
}

function shouldMirrorWorkspaceDirInsideWsl(repoPath: string, workspaceDir: string): boolean {
  if (isWorkspaceDirRelativeToRepo(repoPath, workspaceDir)) {
    return false
  }
  return !isWslUncPath(workspaceDir)
}

export function parseWorktreeId(worktreeId: string): { repoId: string; worktreePath: string } {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    throw new Error(`Invalid worktreeId: ${worktreeId}`)
  }
  return parsed
}

/** Git can prune tracking while leaving the checkout directory on disk. */
export function isOrphanedWorktreeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const msg = (error as { stderr?: string }).stderr || error.message
  return /is not a working tree/.test(msg)
}

export function isWindowsLongPathWorktreeRemovalError(
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32' || typeof error !== 'object' || error === null) {
    return false
  }
  const errorWithDetails = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  const details = [errorWithDetails.stderr, errorWithDetails.stdout, errorWithDetails.message]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')

  // Git for Windows varies filename/path wording and may report via stderr or thrown message.
  return /(?:file ?name|path).{0,40}too long|too long.{0,40}(?:file ?name|path)/i.test(details)
}

export function isOrphanCompatiblePreflightError(error: unknown): boolean {
  if (isOrphanedWorktreeError(error)) {
    return true
  }
  if (!(error instanceof Error)) {
    return false
  }
  const errorWithDetails = error as Error & { code?: unknown; stderr?: string; stdout?: string }
  const details = [
    errorWithDetails.stderr,
    errorWithDetails.stdout,
    errorWithDetails.message,
    typeof errorWithDetails.code === 'string' ? errorWithDetails.code : undefined
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
  return /not a git repository/i.test(details) || /\bENOENT\b/i.test(details)
}

export function formatWorktreeRemovalError(
  error: unknown,
  worktreePath: string,
  force: boolean
): string {
  const fallback = force
    ? `Failed to force delete worktree at ${worktreePath}.`
    : `Failed to delete worktree at ${worktreePath}.`

  if (!(error instanceof Error)) {
    return fallback
  }

  const errorWithStreams = error as Error & { stderr?: string; stdout?: string }
  const details = [errorWithStreams.stderr, errorWithStreams.stdout, error.message]
    .map((value) => value?.trim())
    .find(Boolean)

  return details ? `${fallback} ${details}` : fallback
}
