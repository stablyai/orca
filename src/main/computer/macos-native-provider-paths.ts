import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function resolveMacOSComputerUseAppPath(): string | null {
  const override = process.env.MCODE_COMPUTER_MACOS_HELPER_APP_PATH
  if (override && existsSync(override)) {
    return override
  }

  const packaged = [join(process.resourcesPath ?? '', 'MCode Computer Use.app')]
  const dev = [
    join(process.cwd(), 'native/computer-use-macos/.build/release/MCode Computer Use.app'),
    resolve(__dirname, '../../native/computer-use-macos/.build/release/MCode Computer Use.app')
  ]
  const candidates = process.resourcesPath ? [...packaged, ...dev] : dev

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

export function resolveMacOSComputerUseExecutablePath(): string | null {
  const appPath = resolveMacOSComputerUseAppPath()
  if (!appPath) {
    return null
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', 'mcode-computer-use-macos')
  return existsSync(executablePath) ? executablePath : null
}
