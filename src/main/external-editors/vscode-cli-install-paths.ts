import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

function listVsCodeCliInstallPaths(command: string, platform: NodeJS.Platform): string[] {
  if (command !== 'code' && command !== 'code-insiders') {
    return []
  }
  const insiders = command === 'code-insiders'
  if (platform === 'darwin') {
    // The bundled macOS CLI is named `code` for both stable and Insiders.
    const cli = posix.join(
      insiders ? 'Visual Studio Code - Insiders.app' : 'Visual Studio Code.app',
      'Contents/Resources/app/bin/code'
    )
    return [posix.join('/Applications', cli), posix.join(homedir(), 'Applications', cli)]
  }
  if (platform === 'win32') {
    const cli = win32.join(
      insiders ? 'Microsoft VS Code Insiders' : 'Microsoft VS Code',
      'bin',
      `${command}.cmd`
    )
    const { LOCALAPPDATA, ProgramFiles } = process.env
    return [
      ...(LOCALAPPDATA ? [win32.join(LOCALAPPDATA, 'Programs', cli)] : []),
      ...(ProgramFiles ? [win32.join(ProgramFiles, cli)] : [])
    ]
  }
  // Linux packages link /usr/bin or /snap/bin, which PATH resolution already covers.
  return []
}

/** VS Code's bundled CLI, for GUI launches whose PATH lacks the optional `code` shim. */
export function findInstalledVsCodeCli(
  command: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): string | null {
  return listVsCodeCliInstallPaths(command, platform).find((path) => fileExists(path)) ?? null
}
