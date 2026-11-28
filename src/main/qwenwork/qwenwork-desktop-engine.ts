import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { statWithoutArchiveLock } from '../filesystem/asar-transparent-fs'
import { loadWindowsNativeRegistry } from '../windows/windows-native-registry'

const versionsByNumber = new Intl.Collator('en', { numeric: true })
export const QWENWORK_DESKTOP_PROFILE = 'ORCA_QWENWORK_DESKTOP_PROFILE'

export function defaultQwenWorkDesktopProfile(
  home: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  return platform === 'win32'
    ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'QwenWorkCN')
    : join(home, 'Library', 'Application Support', 'QwenWorkCN')
}

async function findBridge() {
  const name = 'desktop-acp.cjs'
  const scripts = [
    process.resourcesPath && join(process.resourcesPath, 'qwenwork', name),
    resolve(__dirname, '../../../resources/qwenwork', name),
    resolve(__dirname, '../../resources/qwenwork', name)
  ]
  for (const script of scripts) {
    if (script && (await stat(script).catch(() => null))?.isFile()) {
      return script
    }
  }
  return null
}

async function findQwenWorkMacExecutable(env: Readonly<Record<string, string>>) {
  const roots = env.ORCA_QWENWORK_INSTALL_DIR
    ? [env.ORCA_QWENWORK_INSTALL_DIR]
    : ['/Applications/QwenWorkCN.app', '/Applications/千问办公.app']
  for (const candidate of roots) {
    if (!isAbsolute(candidate)) {
      continue
    }
    const root = await realpath(candidate).catch(() => null)
    const command =
      root && (await realpath(join(root, 'Contents', 'MacOS', 'QwenWorkCN')).catch(() => null))
    if (
      root &&
      command &&
      isPathInsideOrEqual(root, command) &&
      (await stat(command).catch(() => null))?.isFile()
    ) {
      return command
    }
  }
  return null
}

function windowsInstallRoot(): string | undefined {
  try {
    const registry = loadWindowsNativeRegistry()
    const uninstallKey =
      'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ffb0f51c-12ba-5803-a677-ac4568a78a2a'
    const icon = registry.getRegistryKey(registry.HK.CU, uninstallKey)?.DisplayIcon?.value
    return typeof icon === 'string' && isAbsolute(icon) ? dirname(icon) : undefined
  } catch {
    return undefined
  }
}

async function windowsExecutableAt(folder: string) {
  try {
    const root = await realpath(folder)
    const command = await realpath(join(root, 'QwenWorkCN.exe'))
    if (
      isPathInsideOrEqual(root, command) &&
      (await stat(command)).isFile() &&
      (await statWithoutArchiveLock(join(root, 'resources', 'app.asar'))).isFile()
    ) {
      return command
    }
  } catch {
    // An incomplete desktop update can leave a version directory without its engine.
  }
  return null
}

async function findQwenWorkWindowsExecutable(env: Readonly<Record<string, string>>) {
  const selected = env.ORCA_QWENWORK_INSTALL_DIR
  const roots = selected
    ? [selected]
    : [windowsInstallRoot(), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'QwenWorkCN')]
  for (const root of roots) {
    if (!root || !isAbsolute(root)) {
      continue
    }
    const direct = await windowsExecutableAt(root)
    if (direct) {
      return direct
    }
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const versions = entries
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+(?:-\d+)?$/.test(e.name))
      .sort((a, b) => versionsByNumber.compare(b.name, a.name))
    for (const version of versions) {
      const found = await windowsExecutableAt(join(root, version.name))
      if (found) {
        return found
      }
    }
  }
  return null
}

export async function findQwenWorkDesktopEngine(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== 'darwin' && platform !== 'win32') {
    return null
  }
  const profile =
    env[QWENWORK_DESKTOP_PROFILE] ?? defaultQwenWorkDesktopProfile(homedir(), env, platform)
  if (!isAbsolute(profile)) {
    return null
  }
  const [bridge, command] = await Promise.all([
    findBridge(),
    platform === 'darwin' ? findQwenWorkMacExecutable(env) : findQwenWorkWindowsExecutable(env)
  ])
  return bridge && command ? { command, prefixArgs: [bridge, profile] } : null
}
