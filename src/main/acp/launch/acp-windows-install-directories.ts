import { join, win32 } from 'node:path'

/** A Windows installer's `<LOCALAPPDATA>\<folder>\bin`, then the profile default it falls back to. */
export function windowsLocalAppDataBinDirectories(
  env: Readonly<Record<string, string>>,
  homePath: string,
  folder: string
): string[] {
  const localAppData = Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1]
    ?.trim()
  return [
    ...new Set([
      ...(localAppData && win32.isAbsolute(localAppData)
        ? [join(localAppData, folder, 'bin')]
        : []),
      join(homePath, 'AppData', 'Local', folder, 'bin')
    ])
  ]
}
