import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../ssh/ssh-connection'
import type { SshExecOptions } from '../ssh/ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from '../ssh/ssh-remote-powershell'

export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

const SSH_BROWSE_TIMEOUT_MS = 15_000

// Why: a cmd.exe DefaultShell returns ERRORLEVEL 9009 for an unrecognized command
// regardless of OS display language, so on the ssh2 transport (which surfaces the
// remote exit code intact) it's the locale-independent signal that a Windows host
// rejected Orca's POSIX `exec` wrapper. Two cases still fall back only via the
// localized stderr heuristics below: the system-ssh transport (truncates the exit
// code to 8 bits, 9009 -> 49) and a powershell.exe DefaultShell (exits 1, not 9009).
const WINDOWS_COMMAND_NOT_FOUND_EXIT = 9009

// Carries the raw exit code so the Windows-fallback predicate can key off the
// locale-independent 9009 rather than parsing localized shell prose.
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
      } catch (error) {
        if (!shouldFallbackToWindowsBrowse(error)) {
          throw error
        }
        try {
          return await browseWithWindowsPowerShell(conn, args.dirPath)
        } catch (fallbackError) {
          // Why: a 9009 exit proves the host is Windows (remote POSIX exits are
          // 8-bit), so PowerShell genuinely ran and its error is the real cause
          // (e.g. "Cannot find path"/"Access is denied") — surface it. The string
          // heuristic can match a POSIX false positive, so there we rethrow the
          // original shell failure instead of a misleading "powershell.exe not found".
          throw isWindowsCommandNotFound(error) ? fallbackError : error
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

// Why: cmd.exe's 9009 exit is the locale-independent proof that a Windows host
// rejected Orca's POSIX `exec` wrapper — remote POSIX shells report 8-bit exit
// codes, so 9009 can only originate from cmd.exe's ERRORLEVEL.
function isWindowsCommandNotFound(error: unknown): boolean {
  return error instanceof RemoteBrowseError && error.exitCode === WINDOWS_COMMAND_NOT_FOUND_EXIT
}

function shouldFallbackToWindowsBrowse(error: unknown): boolean {
  // Fires the fallback even on German/French/Japanese/etc. hosts whose localized
  // stderr text the string heuristics below would miss.
  if (isWindowsCommandNotFound(error)) {
    return true
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  // Why: only retry when the remote login shell rejects Orca's POSIX wrapper.
  // Ordinary POSIX browse failures (permission denied, missing path, etc.)
  // should surface directly instead of being masked by a PowerShell retry.
  return (
    msg.includes('exec') &&
    (msg.includes('not recognized') || msg.includes('no se reconoce') || msg.includes('not found'))
  )
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
