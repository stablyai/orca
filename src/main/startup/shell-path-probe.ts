import { delimiter, win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'

export const SHELL_PATH_DELIMITER = '__ORCA_SHELL_PATH__'

export function shellPathProbe(shell: string): { args: string[]; pathDelimiter: string } {
  if (process.platform !== 'win32') {
    if (pathWin32.basename(shell).toLowerCase() === 'nu') {
      // Why: `nu -ilc` runs, but `"$PATH"` stays the literal text `$PATH`, so hydration
      // reports success and never merges the login PATH. `$env.PATH` is a list.
      const command = [
        `print -n '${SHELL_PATH_DELIMITER}';`,
        'print -n ($env.PATH | str join (char esep));',
        `print -n '${SHELL_PATH_DELIMITER}'`
      ].join(' ')
      return { args: ['-l', '-c', command], pathDelimiter: delimiter }
    }
    const command =
      `printf '%s' '${SHELL_PATH_DELIMITER}'; printf '%s' "$PATH"; ` +
      `printf '%s' '${SHELL_PATH_DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: delimiter }
  }
  if (resolveWindowsShellStartupFamily(shell) === 'posix') {
    // Why: native child processes cannot resolve Git Bash's /c/... PATH entries.
    const command =
      `printf '%s' '${SHELL_PATH_DELIMITER}'; cygpath -wp "$PATH"; ` +
      `printf '%s' '${SHELL_PATH_DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: ';' }
  }
  const command =
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `[Console]::Write('${SHELL_PATH_DELIMITER}'); [Console]::Write($env:Path); ` +
    `[Console]::Write('${SHELL_PATH_DELIMITER}')`
  // Why: omitting -NoProfile is the behavior this probe exists to capture.
  return { args: ['-NoLogo', '-Command', command], pathDelimiter: ';' }
}
