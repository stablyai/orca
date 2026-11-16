import { posix, win32 } from 'node:path'

/** One executable that takes the URL: tools like Expo and Claude spawn BROWSER without a shell (#21956). */
export function resolveTerminalBrowserCommand(
  cliLauncher: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  if (!cliLauncher) {
    return 'orca'
  }
  // Why: xdg-open word-splits BROWSER and every reader splits it on the PATH delimiter.
  const listDelimiter = platform === 'win32' ? ';' : ':'
  if (!/\s/.test(cliLauncher) && !cliLauncher.includes(listDelimiter)) {
    return cliLauncher
  }
  // The launcher's directory was just put first on PATH, so its bare name reaches it.
  return (platform === 'win32' ? win32 : posix).basename(cliLauncher)
}
