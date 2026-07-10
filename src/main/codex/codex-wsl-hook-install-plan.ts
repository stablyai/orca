import { execFileSync } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { getDefaultWslDistro, toLinuxPath } from '../wsl'

export type CodexWslRuntimeHookInstallPlan = {
  configPath: string
  tomlPath: string
  scriptPath: string
  commandScriptPath: string
  trustConfigPath: string
}

export type CanonicalizeWslLinuxPath = (distro: string, linuxPath: string) => string | null

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function canonicalizeWslLinuxPath(distro: string, linuxPath: string): string | null {
  if (process.platform !== 'win32') {
    return linuxPath
  }
  try {
    const canonicalPath = execFileSync(
      'wsl.exe',
      ['-d', distro, '--', 'readlink', '-f', '--', linuxPath],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }
    ).trim()
    return canonicalPath.startsWith('/') ? canonicalPath : null
  } catch {
    return null
  }
}

export function createCodexWslRuntimeHookInstallPlan(
  runtimeHomePath: string | null | undefined,
  target?: CodexAccountSelectionTarget,
  canonicalize: CanonicalizeWslLinuxPath = canonicalizeWslLinuxPath
): CodexWslRuntimeHookInstallPlan | null {
  if (!runtimeHomePath) {
    return null
  }

  const wslInfo = parseWslUncPath(runtimeHomePath)
  if (!wslInfo && target?.runtime !== 'wsl') {
    return null
  }
  const distro =
    wslInfo?.distro ||
    target?.wslDistro?.trim() ||
    (target?.runtime === 'wsl' ? getDefaultWslDistro() : null)
  if (!distro) {
    return null
  }

  const logicalLinuxRuntimeHome = wslInfo?.linuxPath ?? toLinuxPath(runtimeHomePath)
  if (!logicalLinuxRuntimeHome.startsWith('/')) {
    return null
  }
  // Why: Codex canonicalizes hook sources inside WSL; resolving there keeps
  // trust keys valid when HOME or the runtime directory crosses a symlink.
  const linuxRuntimeHome = trimTrailingSlash(
    canonicalize(distro, logicalLinuxRuntimeHome) ?? logicalLinuxRuntimeHome
  )

  return {
    configPath: pathWin32.join(runtimeHomePath, 'hooks.json'),
    tomlPath: pathWin32.join(runtimeHomePath, 'config.toml'),
    scriptPath: pathWin32.join(runtimeHomePath, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxRuntimeHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxRuntimeHome}/hooks.json`
  }
}
