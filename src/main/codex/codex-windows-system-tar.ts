import { existsSync, readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { CODEX_WINDOWS_TAR_SHIM_DIR_ENV } from '../../shared/codex-shell-function'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'

const WINDOWS_SYSTEM_TAR_SHIM = '@"%SystemRoot%\\System32\\tar.exe" %*\r\n'
const WINDOWS_CODEX_TAR_SCOPE_WRAPPER =
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=%~dp0;%PATH%"\r\ncall %*\r\nexit /b %errorlevel%\r\n'

export const CODEX_WINDOWS_TAR_SCOPE_WRAPPER_FILE = 'codex-tar-scope.cmd'

type WindowsSystemTarShimOptions = {
  platform?: NodeJS.Platform
  systemRoot?: string
  fileExists?: (path: string) => boolean
  warn?: (message: string) => void
}

export type CodexWindowsSystemTarEnvOptions = WindowsSystemTarShimOptions & {
  mode: 'inherit' | 'system' | undefined
  isWsl: boolean
  userDataPath: string
}

function codexWindowsTarMarkerKeys(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): string[] {
  return Object.keys(env).filter(
    (key) =>
      key === CODEX_WINDOWS_TAR_SHIM_DIR_ENV ||
      (platform === 'win32' && key.toLowerCase() === CODEX_WINDOWS_TAR_SHIM_DIR_ENV.toLowerCase())
  )
}

export function ensureCodexWindowsSystemTarShim(
  userDataPath: string,
  options: WindowsSystemTarShimOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return null
  }

  const systemRoot = options.systemRoot ?? process.env.SystemRoot
  const warn = options.warn ?? console.warn
  if (!systemRoot) {
    warn('[codex-tar] Windows SystemRoot is unavailable; inheriting PATH')
    return null
  }
  const systemTar = win32.join(systemRoot, 'System32', 'tar.exe')
  if (!(options.fileExists ?? existsSync)(systemTar)) {
    warn(`[codex-tar] Windows system tar is unavailable at ${systemTar}; inheriting PATH`)
    return null
  }

  const shimDir = join(userDataPath, 'shims', 'windows-system-tar')
  const shimPath = join(shimDir, 'tar.cmd')
  const scopeWrapperPath = join(shimDir, CODEX_WINDOWS_TAR_SCOPE_WRAPPER_FILE)
  try {
    if (
      readFileSync(shimPath, 'utf8') === WINDOWS_SYSTEM_TAR_SHIM &&
      readFileSync(scopeWrapperPath, 'utf8') === WINDOWS_CODEX_TAR_SCOPE_WRAPPER
    ) {
      return shimDir
    }
  } catch {
    // Write or repair the shim below.
  }

  return writeShellWrapperFiles(
    [
      [shimPath, WINDOWS_SYSTEM_TAR_SHIM],
      [scopeWrapperPath, WINDOWS_CODEX_TAR_SCOPE_WRAPPER]
    ],
    '[codex-tar]',
    'Codex will inherit tar from PATH'
  )
    ? shimDir
    : null
}

export function applyCodexWindowsSystemTarShimEnv(
  env: Record<string, string>,
  options: CodexWindowsSystemTarEnvOptions
): void {
  const platform = options.platform ?? process.platform
  for (const key of codexWindowsTarMarkerKeys(env, platform)) {
    delete env[key]
  }
  if (platform !== 'win32' || options.isWsl || options.mode !== 'system') {
    return
  }

  const shimDir = ensureCodexWindowsSystemTarShim(options.userDataPath, options)
  if (shimDir) {
    env[CODEX_WINDOWS_TAR_SHIM_DIR_ENV] = shimDir
  }
}
