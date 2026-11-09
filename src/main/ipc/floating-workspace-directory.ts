import { constants as fsConstants } from 'node:fs'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { Store } from '../persistence/loading-store/store'
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

async function selectFloatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
  args?: FloatingTerminalCwdRequest
): Promise<{ path: string; prepare: boolean }> {
  const fallback = { path: getDefaultFloatingWorkspacePath(), prepare: true }
  const configuredPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!configuredPath) {
    return args?.requireTrusted === true
      ? fallback
      : { path: resolveFloatingWorkspaceInput('~'), prepare: false }
  }
  const cwd = resolveFloatingWorkspaceInput(configuredPath)
  const canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
  if (!canonicalCwd) {
    return fallback
  }
  if (isTrustedFloatingWorkspaceDirectory(canonicalCwd, store.getSettings())) {
    return { path: canonicalCwd, prepare: false }
  }
  return args?.requireTrusted === true ? fallback : { path: cwd, prepare: false }
}

export async function readFloatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  const selected = await selectFloatingTerminalCwd(store, args)
  const accessible = await canonicalizeAccessibleDirectory(selected.path)
  if (!accessible) {
    throw new Error('floating_workspace_path_unavailable')
  }
  return selected.path
}

export async function resolveFloatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  const selected = await selectFloatingTerminalCwd(store, args)
  return selected.prepare ? ensureDefaultFloatingWorkspacePath() : selected.path
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
