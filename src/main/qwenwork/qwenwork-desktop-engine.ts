import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { loadWindowsNativeRegistry } from '../windows/windows-native-registry'

const versionsByNumber = new Intl.Collator('en', { numeric: true })

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

async function engineAt(folder: string) {
  try {
    const root = await realpath(folder)
    const sdk = join(root, 'resources', 'agent-sdk')
    const runtime = JSON.parse(await readFile(join(sdk, 'engine-runtime-manifest.json'), 'utf8'))
      .engines?.opencode
    if (
      runtime?.runtime !== 'electron-node' ||
      typeof runtime.entrypoint !== 'string' ||
      !/^components\/flash-cli\/[\w.-]+\/runtime\/[\w.-]+\.mjs$/.test(runtime.entrypoint) ||
      !Array.isArray(runtime.args) ||
      runtime.args.length !== 0
    ) {
      return null
    }
    const entry = await realpath(resolve(sdk, runtime.entrypoint))
    if (!isPathInsideOrEqual(sdk, entry) || !(await stat(entry)).isFile()) {
      return null
    }
    const component = JSON.parse(
      await readFile(join(dirname(dirname(entry)), 'engine-manifest.json'), 'utf8')
    )
    if (component.protocol !== 'acp-stdio' || component.engineId !== 'opencode') {
      return null
    }
    const command = await realpath(join(root, 'QwenWorkCN.exe'))
    if (isPathInsideOrEqual(root, command) && (await stat(command)).isFile()) {
      return { command, prefixArgs: [entry] }
    }
  } catch {
    // An incomplete desktop update can leave a version directory without its engine.
  }
  return null
}

export async function findQwenWorkDesktopEngine(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== 'win32') {
    return null
  }
  const selected = env.ORCA_QWENWORK_INSTALL_DIR
  const roots = selected
    ? [selected]
    : [windowsInstallRoot(), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'QwenWorkCN')]
  for (const root of roots) {
    if (!root || !isAbsolute(root)) {
      continue
    }
    const direct = await engineAt(root)
    if (direct) {
      return direct
    }
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const versions = entries
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+(?:-\d+)?$/.test(e.name))
      .sort((a, b) => versionsByNumber.compare(b.name, a.name))
    for (const version of versions) {
      const found = await engineAt(join(root, version.name))
      if (found) {
        return found
      }
    }
  }
  return null
}
