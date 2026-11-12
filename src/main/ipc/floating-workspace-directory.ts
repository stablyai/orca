import { constants as fsConstants, realpathSync } from 'node:fs'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { Store } from '../persistence/loading-store/store'
import { resolveFloatingWorkspacePath } from '../persistence/restoring-sessions/floating-workspace-normalization'

type FloatingTerminalSettings = Pick<GlobalSettings, 'floatingTerminalTrustedCwds'>
type FloatingWorkspaceSettings = FloatingTerminalSettings &
  Partial<Pick<GlobalSettings, 'floatingTerminalCwd'>>

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

let resolvedHomeCache: { home: string; real: string } | null = null

/** Home as spelled and as resolved through any link (e.g. /home -> /var/home), resolved once per home. */
function resolvedHome(): { home: string; real: string } {
  const home = path.resolve(getAppEnvironment().getPath('home'))
  if (resolvedHomeCache?.home !== home) {
    let real = home
    try {
      real = path.resolve(realpathSync.native(home))
    } catch {
      // An unreadable home keeps its spelled path.
    }
    resolvedHomeCache = { home, real }
  }
  return resolvedHomeCache
}

/** A folder above home (such as `/`) was never what trusting a cwd meant; home itself, trusted explicitly, is. */
function isAboveHomeDirectory(dir: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'linux' ? value : value.toLowerCase()
  const { home: spelled, real } = resolvedHome()
  return [spelled, real].some((home) => {
    const rel = path.relative(fold(dir), fold(home))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  })
}

/** Roots the floating workspace owns for file access; an untrusted cwd, or one above home, adds none. */
export function getFloatingWorkspaceFileRoots(store: {
  getSettings(): FloatingWorkspaceSettings
}): {
  extraRoots: string[]
  exactRoots: string[]
} {
  const settings = store.getSettings()
  const configuredPath =
    typeof settings.floatingTerminalCwd === 'string' ? settings.floatingTerminalCwd.trim() : ''
  // Canonical home: trust entries are canonical, so `~` must expand to the spelling they store.
  const cwd = configuredPath
    ? resolveFloatingWorkspacePath(configuredPath, resolvedHome().real)
    : null
  return {
    extraRoots: [getDefaultFloatingWorkspacePath()],
    // Exact: trusted entries are canonical, so a trusted cwd later replaced by a link fails closed.
    exactRoots:
      cwd && isTrustedFloatingWorkspaceDirectory(cwd, settings) && !isAboveHomeDirectory(cwd)
        ? [cwd]
        : []
  }
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
  return floatingTerminalCwd(store, args, ensureDefaultFloatingWorkspacePath)
}

/** Discovery must not create a fallback directory merely to list models. */
export async function readFloatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
  args?: FloatingTerminalCwdRequest
): Promise<string> {
  return floatingTerminalCwd(store, args, async () => {
    const cwd = await canonicalizeAccessibleDirectory(getDefaultFloatingWorkspacePath())
    if (!cwd) {
      throw new Error('floating_workspace_path_unavailable')
    }
    return cwd
  })
}

async function floatingTerminalCwd(
  store: { getSettings(): FloatingTerminalSettings },
  args: FloatingTerminalCwdRequest | undefined,
  defaultPath: () => Promise<string>
): Promise<string> {
  const configuredPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!configuredPath) {
    return args?.requireTrusted === true ? defaultPath() : resolveFloatingWorkspaceInput('~')
  }

  const cwd = resolveFloatingWorkspaceInput(configuredPath)
  const canonicalCwd = await canonicalizeAccessibleDirectory(cwd)
  if (!canonicalCwd) {
    return defaultPath()
  }

  // Only picker-approved directories may become terminal cwd.
  if (isTrustedFloatingWorkspaceDirectory(canonicalCwd, store.getSettings())) {
    return canonicalCwd
  }

  return args?.requireTrusted === true ? defaultPath() : cwd
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
  // Why spelling only for existing entries: re-resolving them would re-point a trusted folder since swapped for a link.
  const trustedDirectories = getTrustedFloatingWorkspaceDirectories(store.getSettings())
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
