import { win32 } from 'node:path'
import {
  getLauncherBaseName,
  isWindowsBatchLauncher,
  stripMatchingQuotes
} from './editor-launcher-name'

// JetBrains console shims can spawn visible helpers despite windowsHide; prefer GUI siblings.
const JETBRAINS_WINDOWS_CONSOLE_TO_GUI: Readonly<Record<string, string>> = {
  idea: 'idea64',
  webstorm: 'webstorm64',
  pycharm: 'pycharm64',
  phpstorm: 'phpstorm64',
  goland: 'goland64',
  rider: 'rider64',
  clion: 'clion64',
  rubymine: 'rubymine64',
  datagrip: 'datagrip64',
  rustrover: 'rustrover64',
  studio: 'studio64'
}

const JETBRAINS_WINDOWS_GUI_NAMES = new Set(Object.values(JETBRAINS_WINDOWS_CONSOLE_TO_GUI))

function getGuiExecutableName(launcherBaseName: string): string | null {
  if (JETBRAINS_WINDOWS_GUI_NAMES.has(launcherBaseName)) {
    return launcherBaseName
  }
  return JETBRAINS_WINDOWS_CONSOLE_TO_GUI[launcherBaseName] ?? null
}

/** Search only beside the resolved launcher; PATH could select another install or block main again. */
export function resolveColocatedJetBrainsGuiExecutable(
  resolvedCommand: string,
  fileExists: (path: string) => boolean
): string | null {
  const unquoted = stripMatchingQuotes(resolvedCommand)
  const baseName = getLauncherBaseName(unquoted)
  const isBatch = /\.(?:cmd|bat)$/i.test(unquoted)
  const isExe = /\.exe$/i.test(unquoted)
  if (!isBatch && !isExe) {
    return null
  }

  if (isExe) {
    const guiName = JETBRAINS_WINDOWS_CONSOLE_TO_GUI[baseName]
    if (!guiName) {
      return null
    }
    const candidate = win32.join(win32.dirname(unquoted), `${guiName}.exe`)
    return fileExists(candidate) ? candidate : null
  }

  const guiName = getGuiExecutableName(baseName)
  if (!guiName) {
    return null
  }
  const candidate = win32.join(win32.dirname(unquoted), `${guiName}.exe`)
  return fileExists(candidate) ? candidate : null
}

// Detach JetBrains shims with persistent console helpers; other GUI shims must retain quoted argv.
export function isJetBrainsConsoleShim(command: string, platform: NodeJS.Platform): boolean {
  return (
    platform === 'win32' &&
    isWindowsBatchLauncher(command) &&
    getGuiExecutableName(getLauncherBaseName(command)) !== null
  )
}
