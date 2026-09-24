import { win32 } from 'node:path'

function isNativeAbsolutePath(value: string | undefined): value is string {
  return Boolean(value && win32.isAbsolute(value) && win32.parse(value).root.length > 1)
}

/** Keep native shell children from mistaking an inherited MSYS environment for Git Bash. */
export function normalizeWindowsNativeShellEnvironment(
  env: Record<string, string>,
  shellPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (
    platform !== 'win32' ||
    !/^(?:powershell|pwsh|cmd)(?:\.exe)?$/i.test(win32.basename(shellPath))
  ) {
    return
  }
  const keys = Object.keys(env)
  const read = (name: string): string | undefined =>
    env[name] ?? env[keys.find((key) => key.toUpperCase() === name) ?? name]
  const localAppData = read('LOCALAPPDATA')
  const userProfile = read('USERPROFILE')
  const systemRoot = read('SYSTEMROOT')
  const nativeTemp = [
    read('TMP'),
    read('TEMP'),
    isNativeAbsolutePath(localAppData) ? win32.join(localAppData, 'Temp') : undefined,
    isNativeAbsolutePath(userProfile)
      ? win32.join(userProfile, 'AppData', 'Local', 'Temp')
      : undefined,
    isNativeAbsolutePath(systemRoot) ? win32.join(systemRoot, 'Temp') : undefined
  ].find(isNativeAbsolutePath)

  for (const key of keys) {
    const name = key.toUpperCase()
    // Cursor's MSYSTEM/EXEPATH detection overrides even an explicit PowerShell SHELL.
    if (name === 'MSYSTEM' || name === 'EXEPATH' || name === 'SHELL') {
      delete env[key]
    } else if ((name === 'TEMP' || name === 'TMP') && env[key] && !isNativeAbsolutePath(env[key])) {
      // Native Node and Git Bash resolve /tmp to different directories.
      if (nativeTemp) {
        env[key] = nativeTemp
      } else {
        delete env[key]
      }
    }
  }
  env.SHELL = shellPath
}
