import { existsSync } from 'fs'
import { join, resolve } from 'path'

export type DesktopScriptPlatform = 'linux' | 'windows'

export function desktopScriptPlatform(): DesktopScriptPlatform | null {
  if (process.platform === 'linux') {
    return 'linux'
  }
  if (process.platform === 'win32') {
    return 'windows'
  }
  return null
}

export function resolveDesktopScriptProviderPath(
  platform = desktopScriptPlatform()
): string | null {
  const override = process.env.ORCA_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH
  if (override && existsSync(override)) {
    return override
  }
  if (!platform) {
    return null
  }

  const filename = platform === 'windows' ? 'runtime.ps1' : 'runtime.py'
  const directory = platform === 'windows' ? 'computer-use-windows' : 'computer-use-linux'
  const sourceDirectory =
    platform === 'windows' ? 'native/computer-use-windows' : 'native/computer-use-linux'
  const packaged = [join(process.resourcesPath ?? '', directory, filename)]
  const dev = [
    join(process.cwd(), sourceDirectory, filename),
    resolve(__dirname, '../../', sourceDirectory, filename)
  ]
  const candidates = process.resourcesPath ? [...packaged, ...dev] : dev

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}
