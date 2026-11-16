import { posix, win32 } from 'node:path'

/** One executable that takes the URL: tools like Expo and Claude spawn BROWSER without a shell (#21956). */
export function resolveTerminalBrowserCommand(
  cliLauncher: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  if (!cliLauncher) {
    return 'orca'
  }
  // Why: xdg-open splits BROWSER on spaces and ':', Python reads '%s' as a template, gh eats '\'.
  if (platform !== 'win32' && !/[\s:]|%s/.test(cliLauncher)) {
    return cliLauncher
  }
  // The launcher's directory was just put first on PATH, so its bare name reaches it.
  return (platform === 'win32' ? win32 : posix).basename(cliLauncher)
}
