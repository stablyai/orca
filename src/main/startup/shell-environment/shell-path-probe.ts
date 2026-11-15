import { delimiter, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import { isPosixPwshShell, POSIX_PWSH_LOGIN_ARG } from '../../pty/shell-startup/posix-pwsh'

export const SHELL_PATH_DELIMITER = '__ORCA_SHELL_PATH__'

/** Own session on POSIX so an `-i` probe can't take the launching terminal's foreground; Windows `detached` opens a console. */
export function shellProbeDetached(): boolean {
  return process.platform !== 'win32'
}

/** Build the login PATH probe in the selected shell's native syntax. */
export function shellPathProbe(shell: string): {
  args: string[]
  pathDelimiter: string
  detached: boolean
} {
  return { ...shellPathProbeCommand(shell), detached: shellProbeDetached() }
}

function shellPathProbeCommand(shell: string): { args: string[]; pathDelimiter: string } {
  if (process.platform !== 'win32') {
    if (isPosixPwshShell(shell)) {
      // pwsh rejects -ilc and Unix env names are case-sensitive ($env:PATH, not Path).
      const command =
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
        `[Console]::Write('${SHELL_PATH_DELIMITER}'); [Console]::Write($env:PATH); ` +
        `[Console]::Write('${SHELL_PATH_DELIMITER}')`
      return {
        args: [POSIX_PWSH_LOGIN_ARG, '-NoLogo', '-NonInteractive', '-Command', command],
        pathDelimiter: pathPosix.delimiter
      }
    }
    if (pathWin32.basename(shell).toLowerCase() === 'nu') {
      // Nushell stores PATH as a list; POSIX quoting would print a literal.
      const command = [
        `print -n '${SHELL_PATH_DELIMITER}';`,
        'print -n ($env.PATH | str join (char esep));',
        `print -n '${SHELL_PATH_DELIMITER}'`
      ].join(' ')
      // Retain interactive login flags for $nu.is-interactive rc behavior.
      return { args: ['-ilc', command], pathDelimiter: delimiter }
    }
    const command =
      `printf '%s' '${SHELL_PATH_DELIMITER}'; printf '%s' "$PATH"; ` +
      `printf '%s' '${SHELL_PATH_DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: delimiter }
  }
  if (resolveWindowsShellStartupFamily(shell) === 'posix') {
    // Native children cannot resolve Git Bash /c/... PATH entries.
    const command =
      `printf '%s' '${SHELL_PATH_DELIMITER}'; cygpath -wp "$PATH"; ` +
      `printf '%s' '${SHELL_PATH_DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: ';' }
  }
  const command =
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `[Console]::Write('${SHELL_PATH_DELIMITER}'); [Console]::Write($env:Path); ` +
    `[Console]::Write('${SHELL_PATH_DELIMITER}')`
  // Load profiles to capture user configuration; do not pass NoProfile.
  return { args: ['-NoLogo', '-Command', command], pathDelimiter: ';' }
}
