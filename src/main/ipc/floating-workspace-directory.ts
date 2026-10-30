import { constants as fsConstants } from 'node:fs'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { Store } from '../persistence'
import { resolveFloatingWorkspacePath } from '../persistence/restoring-sessions/floating-workspace-normalization'

type FloatingTerminalSettings = Pick<GlobalSettings, 'floatingTerminalTrustedCwds'>

const FLOATING_WORKSPACE_DIRNAME = 'floating-workspace'

function resolveFloatingWorkspaceInput(input: string): string {
  // Headless runtime uses this path resolver without an Electron app.
  return resolveFloatingWorkspacePath(input, getAppEnvironment().getPath('home'))
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

function getTrustedFloatingWorkspaceDirectories(settings: FloatingTerminalSettings): Set<string> {
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
  settings: FloatingTerminalSettings
): boolean {
  return getTrustedFloatingWorkspaceDirectories(settings).has(path.resolve(canonicalDirPath))
}

/** Default folder for floating Markdown documents. */
export function getDefaultFloatingWorkspacePath(): string {
  // Headless runtime uses this resolver too.
  return path.join(getAppEnvironment().getPath('userData'), FLOATING_WORKSPACE_DIRNAME)
}

export async function ensureDefaultFloatingWorkspacePath(): Promise<string> {
  const cwd = getDefaultFloatingWorkspacePath()
  await mkdir(cwd, { recursive: true })
  return cwd
}

export async function resolveFloatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
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

  // Only picker-approved directories may become terminal cwd.
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
  const resolvedDir = resolveFloatingWorkspaceInput(trimmed)
  const canonicalDir = await canonicalizeAccessibleDirectory(resolvedDir)
  if (!canonicalDir || !isTrustedFloatingWorkspaceDirectory(canonicalDir, store.getSettings())) {
    return ''
  }
  return canonicalDir
}
