import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../ssh/ssh-connection'
import type { SshExecOptions } from '../ssh/ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from '../ssh/ssh-remote-powershell'

export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

const SSH_BROWSE_TIMEOUT_MS = 15_000

// Why: a POSIX login shell that can't find powershell.exe exits 127 (the POSIX
// "command not found" convention, identical across sh/bash/zsh and locales). It's
// the locale-independent signal that the Windows fallback never actually ran, so
// the original POSIX failure — not the doomed retry — is the real error.
//
// Note: cmd.exe's ERRORLEVEL for an unrecognized command is 9009, but that value
// never crosses cmd.exe's process boundary. sshd forwards cmd.exe's *process* exit
// code, which is 1 — verified on real Windows OpenSSH + cmd.exe over both the ssh2
// and system-ssh transports. So a Windows host rejecting Orca's POSIX `exec`
// wrapper is detected by "the remote command ran and exited non-zero"
// (RemoteBrowseError), not by a magic exit code or localized stderr text.
const POSIX_COMMAND_NOT_FOUND_EXIT = 127

// Carries the raw exit code so the fallback can (a) recognize that the remote
// command actually ran and failed — the locale-independent trigger for the
// Windows retry — and (b) tell a POSIX "powershell.exe not found" (127) apart
// from a genuine PowerShell error, without parsing localized shell prose.
class RemoteBrowseError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message)
    this.name = 'RemoteBrowseError'
  }
}

// Why: the relay's fs.readDir enforces workspace root ACLs, which aren't
// registered until a repo is added. This handler uses a raw SSH exec channel
// to list directories, allowing the user to browse the remote filesystem
// during the "add remote project" flow before any roots exist.
export function registerSshBrowseHandler(
  getConnectionManager: () => SshConnectionManager | null
): void {
  ipcMain.removeHandler('ssh:browseDir')

  ipcMain.handle(
    'ssh:browseDir',
    async (
      _event,
      args: { targetId: string; dirPath: string }
    ): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> => {
      const mgr = getConnectionManager()
      if (!mgr) {
        throw new Error('SSH connection manager not initialized')
      }
      const conn = mgr.getConnection(args.targetId)
      if (!conn) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }

      try {
        return await browseWithPosixShell(conn, args.dirPath)
      } catch (posixError) {
        // Why: a Windows login shell (cmd.exe/PowerShell) rejects Orca's POSIX
        // `exec` wrapper, and the only locale-independent signal for that is "the
        // remote command executed and exited non-zero" (RemoteBrowseError). Its
        // stderr prose is localized, and cmd.exe's 9009 ERRORLEVEL never reaches
        // us (sshd forwards process exit 1). Transport errors/timeouts aren't
        // RemoteBrowseErrors, so a dropped connection is never retried as Windows.
        if (!(posixError instanceof RemoteBrowseError)) {
          throw posixError
        }
        try {
          return await browseWithWindowsPowerShell(conn, args.dirPath)
        } catch (fallbackError) {
          // Why: if the login shell couldn't find powershell.exe (exit 127) the
          // host isn't Windows — surface the original POSIX failure rather than a
          // misleading "powershell.exe: not found". Otherwise PowerShell genuinely
          // ran and its error (e.g. "Cannot find path") is the real cause.
          throw isPosixCommandNotFound(fallbackError) ? posixError : fallbackError
        }
      }
    }
  )
}

type SshBrowseConnection = NonNullable<ReturnType<SshConnectionManager['getConnection']>>

function browseWithPosixShell(
  conn: SshBrowseConnection,
  dirPath: string
): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> {
  // Why: using one line per entry preserves filenames containing spaces.
  // `command ls` bypasses user aliases/functions like `ls='eza ...'`.
  // The -1 flag outputs one entry per line. The -p flag appends / to directories.
  // We resolve ~ and get the absolute path via `cd <path> && pwd`.
  // `cd` and `ls` are chained with `&&` so a failing `ls` (e.g. permission
  // denied after a readable `cd ... && pwd`) propagates as a non-zero exit
  // code rather than being indistinguishable from an empty directory.
  return runBrowseCommand(conn, `cd ${shellEscape(dirPath)} && pwd && command ls -1Ap`)
}

function browseWithWindowsPowerShell(
  conn: SshBrowseConnection,
  dirPath: string
): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Why: Windows PowerShell 5.1 writes redirected stdout in the legacy OEM
    // code page, but runBrowseCommand decodes as UTF-8; pin UTF-8 output so
    // non-ASCII names (e.g. C:\Users\José, CJK, Cyrillic) don't come back mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$dir = ${powerShellPathExpression(dirPath)}`,
    'Set-Location -LiteralPath $dir',
    '$resolved = (Get-Location).ProviderPath',
    // Why: the renderer's parentPath/joinPath only split on `/`, so a native
    // backslash path (C:\Users\alice) breaks "Up" and mixes separators. Emit a
    // forward-slash resolvedPath (matching the POSIX branch) while keeping the
    // native $resolved for Get-ChildItem -LiteralPath.
    "Write-Output ($resolved -replace '\\\\', '/')",
    'Get-ChildItem -LiteralPath $resolved -Force | ForEach-Object {',
    "  if ($_.PSIsContainer) { Write-Output ($_.Name + '/') } else { Write-Output $_.Name }",
    '}'
  ].join('; ')

  return runBrowseCommand(conn, powerShellCommand(script), { wrapCommand: false })
}

async function runBrowseCommand(
  conn: SshBrowseConnection,
  command: string,
  options?: SshExecOptions
): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> {
  const channel = options ? await conn.exec(command, options) : await conn.exec(command)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      channel.off('data', onStdoutData)
      channel.stderr.off('data', onStderrData)
      channel.off('exit', onExit)
      channel.off('close', onClose)
      channel.off('error', onError)
      channel.stderr.off('error', onError)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const closeChannel = (): void => {
      const closable = channel as { close?: () => void; destroy?: () => void }
      try {
        if (typeof closable.close === 'function') {
          closable.close()
        } else if (typeof closable.destroy === 'function') {
          closable.destroy()
        }
      } catch {
        /* best effort */
      }
    }
    const onTimeout = (): void => {
      // Why: remote browsing runs before a relay workspace root exists, so
      // it cannot rely on relay request deadlines. Bound this raw exec
      // channel directly to keep Add Remote Project from hanging forever.
      rejectOnce(new Error('Remote directory listing timed out'))
      closeChannel()
    }
    const resolveOnce = (result: { entries: RemoteDirEntry[]; resolvedPath: string }): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }

    const onStdoutData = (data: Buffer): void => {
      stdout += data.toString()
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString()
    }
    // `exit` fires before `close`; capture the code so we can distinguish
    // a failed `ls` that still produced `pwd` output from an empty listing.
    const onExit = (code: number | null): void => {
      exitCode = code
    }
    const onError = (error: Error): void => {
      rejectOnce(error)
    }
    const onClose = (): void => {
      // A null exitCode means the server closed the channel without
      // sending an exit-status message (or signalled termination). We
      // can't assume success — falling back to "empty stdout = empty
      // directory" is exactly the bug the exit-code branch was added to
      // fix. Treat any non-zero OR null exit as a failure when stderr
      // has content, and otherwise require stdout to contain at least
      // the resolved `pwd` line before accepting the result.
      if (exitCode !== 0) {
        const msg =
          stderr.trim() ||
          (exitCode === null
            ? 'Remote listing failed (channel closed without exit status)'
            : `Remote listing failed (exit ${exitCode})`)
        rejectOnce(new RemoteBrowseError(msg, exitCode))
        return
      }
      if (stderr.trim() && !stdout.trim()) {
        rejectOnce(new Error(stderr.trim()))
        return
      }

      // Why: Windows OpenSSH exec emits CRLF, so split on \r?\n — otherwise a
      // trailing \r defeats the endsWith('/') dir check and leaves a stray CR
      // in every name.
      const lines = stdout.trim().split(/\r?\n/)
      if (lines.length === 0) {
        rejectOnce(new Error('Empty response from remote'))
        return
      }

      const resolvedPath = lines[0]
      const entries: RemoteDirEntry[] = []

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        if (!line || line === './' || line === '../') {
          continue
        }
        if (line.endsWith('/')) {
          entries.push({ name: line.slice(0, -1), isDirectory: true })
        } else {
          entries.push({ name: line, isDirectory: false })
        }
      }

      // Sort: directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })

      resolveOnce({ entries, resolvedPath })
    }

    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('exit', onExit)
    channel.on('close', onClose)
    // Why: SSH exec streams emit `error` on transport loss; without a
    // scoped listener, a disappearing remote can become process-fatal.
    channel.on('error', onError)
    channel.stderr.on('error', onError)
    timeout = setTimeout(onTimeout, SSH_BROWSE_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}

// Why: a POSIX login shell that can't find powershell.exe exits 127, marking the
// Windows fallback as "never ran" — the host isn't Windows, so the original POSIX
// failure, not the doomed retry, is the error worth surfacing.
function isPosixCommandNotFound(error: unknown): boolean {
  return error instanceof RemoteBrowseError && error.exitCode === POSIX_COMMAND_NOT_FOUND_EXIT
}

// Why: prevent shell injection in the directory path. Single-quote wrapping
// with escaped internal single quotes is the safest approach for sh/bash.
// Tilde must be expanded by the shell, so paths starting with ~ use $HOME
// substitution instead of literal quoting (single quotes suppress expansion).
function shellEscape(s: string): string {
  if (s === '~') {
    return '"$HOME"'
  }
  if (s.startsWith('~/')) {
    return `"$HOME"/${shellEscapeRaw(s.slice(2))}`
  }
  return shellEscapeRaw(s)
}

function shellEscapeRaw(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function powerShellPathExpression(s: string): string {
  if (s === '~') {
    return '$HOME'
  }
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return `Join-Path $HOME ${powerShellLiteral(s.slice(2))}`
  }
  return powerShellLiteral(normalizeWindowsDrivePath(s))
}

// Why: browse emits forward-slash Windows paths, so the renderer rebuilds them
// with POSIX helpers — the breadcrumb prepends a spurious leading '/' before the
// drive (/C:/Users) and "Up" from a first-level dir yields a bare drive letter
// (C:). Both are wrong for Set-Location: a leading '/' means the current drive's
// root, and 'C:' is drive-relative (the process cwd), not 'C:\'. Normalize both
// back to a rooted drive path here so navigation lands where the user clicked.
function normalizeWindowsDrivePath(s: string): string {
  const stripped = s.replace(/^\/(?=[A-Za-z]:(?:[/\\]|$))/, '')
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped
}
