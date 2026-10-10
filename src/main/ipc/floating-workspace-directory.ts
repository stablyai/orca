import { constants as fsConstants } from 'node:fs'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { Store } from '../persistence'

const FLOATING_WORKSPACE_DIRNAME = 'floating-workspace'

function expandHomePath(input: string, home: string): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(home, input.slice(2))
  }
  if (process.platform === 'win32' && input.startsWith('~/')) {
    return path.join(home, input.slice(2))
  }
  return input
}

function resolveFloatingWorkspaceInput(input: string): string {
  // Why the environment port: the headless runtime resolves this too, and it has no Electron app.
  const home = getAppEnvironment().getPath('home')
  const expanded = expandHomePath(input, home)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(home, expanded)
}

async function canonicalizeAccessibleDirectory(dirPath: string): Promise<string | null> {
  try {
    const dirStats = await stat(dirPath)
    if (!dirStats.isDirectory()) {
      return null
    }
    await access(dirPath, fsConstants.R_OK | fsConstants.X_OK)
    return path.resolve(await realpath(dirPath))
  } catch {
    return null
  }
}

// Why no trim on read: entries are canonicalized real paths when stored, and a trailing
// space is a legal POSIX directory name (Google Drive exports them) — trimming here would
// break the trust match for those directories.
function getTrustedFloatingWorkspaceDirectories(settings: GlobalSettings): Set<string> {
  return new Set(
    (settings.floatingTerminalTrustedCwds ?? [])
      .filter((trustedPath) => trustedPath.length > 0)
      .map(resolveFloatingWorkspaceInput)
  )
}

async function getPreservedTrustedFloatingWorkspaceDirectories(
  settings: GlobalSettings
): Promise<Set<string>> {
  const trustedDirectories = new Set<string>()
  for (const trustedDir of getTrustedFloatingWorkspaceDirectories(settings)) {
    const canonicalDir = await canonicalizeAccessibleDirectory(trustedDir)
    trustedDirectories.add(canonicalDir ?? trustedDir)
  }
  return trustedDirectories
}

function isTrustedFloatingWorkspaceDirectory(
  canonicalDirPath: string,
  settings: GlobalSettings
): boolean {
  return getTrustedFloatingWorkspaceDirectories(settings).has(path.resolve(canonicalDirPath))
}

/** The app-owned folder floating markdown documents are created in; a desktop-only root. */
export function getDefaultFloatingWorkspacePath(): string {
  // Why the environment port: the headless runtime resolves this too, and it has no Electron app.
  return path.join(getAppEnvironment().getPath('userData'), FLOATING_WORKSPACE_DIRNAME)
}

export async function ensureDefaultFloatingWorkspacePath(): Promise<string> {
  const cwd = getDefaultFloatingWorkspacePath()
  await mkdir(cwd, { recursive: true })
  return cwd
}

export async function resolveFloatingTerminalCwd(
  store: Store,
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  const configuredPath = typeof args?.path === 'string' ? args.path : ''
  if (!configuredPath.trim()) {
    return args?.requireTrusted === true
      ? ensureDefaultFloatingWorkspacePath()
      : resolveFloatingWorkspaceInput('~')
  }

  // Why raw first: a trailing space is a legal POSIX directory name, so a stored
  // picker-verified path must resolve as typed; the trim only cleans typed typos.
  let cwd = resolveFloatingWorkspaceInput(configuredPath)
  let canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
  if (!canonicalCwd) {
    cwd = resolveFloatingWorkspaceInput(configuredPath.trim())
    canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
    if (!canonicalCwd) {
      return ensureDefaultFloatingWorkspacePath()
    }
  }

  // Why: only picker-approved directories may become the cwd, so arbitrary settings text can't.
  if (isTrustedFloatingWorkspaceDirectory(canonicalCwd, store.getSettings())) {
    return canonicalCwd
  }

  return args?.requireTrusted === true ? ensureDefaultFloatingWorkspacePath() : cwd
}

export async function trustFloatingWorkspaceDirectory(
  store: Pick<Store, 'getSettings' | 'updateSettings'>,
  dirPath: string
): Promise<void> {
  const resolvedDir = resolveFloatingWorkspaceInput(dirPath)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir) {
    return
  }
  const trustedDirectories = await getPreservedTrustedFloatingWorkspaceDirectories(
    store.getSettings()
  )
  trustedDirectories.add(canonicalDir)
  store.updateSettings({
    floatingTerminalTrustedCwds: [...trustedDirectories]
  })
}

export async function sanitizeFloatingWorkspaceDirectorySetting(
  store: Store,
  dirPath: string
): Promise<string> {
  const trimmed = dirPath.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed === '~') {
    return '~'
  }
  // Why raw first: a trailing space is a legal POSIX directory name, so a picked
  // directory must sanitize as typed; the trim only cleans typed typos.
  const canonicalDir =
    (await canonicalizeAccessibleDirectory(resolveFloatingWorkspaceInput(dirPath))) ??
    (await canonicalizeAccessibleDirectory(resolveFloatingWorkspaceInput(trimmed)))
  if (!canonicalDir || !isTrustedFloatingWorkspaceDirectory(canonicalDir, store.getSettings())) {
    return ''
  }
  return canonicalDir
}
