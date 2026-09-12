import { win32 } from 'node:path'
import {
  getLauncherBaseName,
  isWindowsBatchLauncher,
  stripMatchingQuotes
} from './editor-launcher-name'

// Why: JetBrains installers ship `*64.exe` GUI-subsystem binaries. The
// Toolbox/installer `.cmd`/`.bat` shims (and short-name console `idea.exe`
// stubs) chain through helpers that allocate a visible Command Prompt even
// when the parent spawn uses windowsHide — the STA-3040 prompt-window loop.
// Maps each short console launcher name to its GUI sibling.
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

/** GUI binary basename for a console or GUI launcher name, or null if unknown. */
function getGuiExecutableName(launcherBaseName: string): string | null {
  if (JETBRAINS_WINDOWS_GUI_NAMES.has(launcherBaseName)) {
    return launcherBaseName
  }
  return JETBRAINS_WINDOWS_CONSOLE_TO_GUI[launcherBaseName] ?? null
}

/**
 * The GUI `*64.exe` beside an already-resolved console entry point, or null.
 *
 * Why sibling-only: a bare PATH lookup for `idea64` can land in a different,
 * stale install, and it costs a second full PATH walk on Electron's main
 * thread. Toolbox script directories ship no exe, so those keep the shim and
 * rely on the detached-GUI spawn instead.
 *
 * Upgrades:
 * - `idea.cmd` / `idea.bat` / `idea64.cmd` → colocated `idea64.exe` when present
 * - short-name console stubs `idea.exe` → colocated `idea64.exe` when present
 * - leaves `idea64.exe` and non-JetBrains launchers unchanged
 */
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

  // .exe: only short console names (idea.exe), never the GUI binary itself.
  if (isExe) {
    const guiName = JETBRAINS_WINDOWS_CONSOLE_TO_GUI[baseName]
    if (!guiName) {
      return null
    }
    const candidate = win32.join(win32.dirname(unquoted), `${guiName}.exe`)
    return fileExists(candidate) ? candidate : null
  }

  // .cmd/.bat: idea.cmd and idea64.cmd both prefer idea64.exe when colocated.
  const guiName = getGuiExecutableName(baseName)
  if (!guiName) {
    return null
  }
  const candidate = win32.join(win32.dirname(unquoted), `${guiName}.exe`)
  return fileExists(candidate) ? candidate : null
}

// Why: only JetBrains batch shims chain through console helpers that outlive
// the batch and re-open a prompt. Other GUI shims (code.cmd, cursor.cmd) exit
// on their own, and running them under `start` would re-parse their quoted
// WSL/SSH remote argv. detachedGui only rewrites batch targets.
export function isJetBrainsConsoleShim(command: string, platform: NodeJS.Platform): boolean {
  return (
    platform === 'win32' &&
    isWindowsBatchLauncher(command) &&
    getGuiExecutableName(getLauncherBaseName(command)) !== null
  )
}
