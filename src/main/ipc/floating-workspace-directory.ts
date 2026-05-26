import { constants as fsConstants } from 'node:fs'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { GlobalSettings, FloatingTerminalCwdRequest } from '../../shared/types'
import type { Store } from '../persistence'
import { authorizeExternalPath } from './filesystem-auth'

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
  const home = app.getPath('home')
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

function getTrustedFloatingWorkspaceDirectories(settings: GlobalSettings): Set<string> {
  return new Set(
    (settings.floatingTerminalTrustedCwds ?? [])
      .map((trustedPath) => trustedPath.trim())
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

export async function ensureDefaultFloatingWorkspacePath(): Promise<string> {
  const cwd = path.join(app.getPath('userData'), FLOATING_WORKSPACE_DIRNAME)
  await mkdir(cwd, { recursive: true })
  // Why: the default floating workspace lives outside repo roots by design;
  // authorize only this app-owned directory instead of widening access to ~.
  authorizeExternalPath(cwd)
  return cwd
}

export async function resolveFloatingTerminalCwd(
  store: Store,
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  const configuredPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!configuredPath) {
    return args?.requireTrusted === true
      ? ensureDefaultFloatingWorkspacePath()
      : resolveFloatingWorkspaceInput('~')
  }

  const cwd = resolveFloatingWorkspaceInput(configuredPath)
  const canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
  if (!canonicalCwd) {
    return ensureDefaultFloatingWorkspacePath()
  }

  if (isTrustedFloatingWorkspaceDirectory(canonicalCwd, store.getSettings())) {
    // Why: picker-approved directories are persisted as explicit grants, so a
    // restart can restore file creation access without trusting arbitrary text.
    authorizeExternalPath(canonicalCwd)
    return canonicalCwd
  }

  return args?.requireTrusted === true ? ensureDefaultFloatingWorkspacePath() : cwd
}

export async function grantFloatingWorkspaceDirectory(
  store: Store,
  dirPath: string
): Promise<void> {
  const resolvedDir = resolveFloatingWorkspaceInput(dirPath)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir) {
    return
  }
  authorizeExternalPath(canonicalDir)
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
  const resolvedDir = resolveFloatingWorkspaceInput(trimmed)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir || !isTrustedFloatingWorkspaceDirectory(canonicalDir, store.getSettings())) {
    return ''
  }
  return canonicalDir
}
