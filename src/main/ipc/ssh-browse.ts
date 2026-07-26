import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../ssh/ssh-connection'
import type { SshExecOptions } from '../ssh/ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from '../ssh/ssh-remote-powershell'

export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

const SSH_BROWSE_TIMEOUT_MS = 15_000

// Why: 127 = POSIX "command not found" (locale-independent) — the Windows fallback never ran, so the original POSIX error is the real one.
const POSIX_COMMAND_NOT_FOUND_EXIT = 127

// Carries the raw exit code so the fallback can distinguish 127 (no powershell.exe → not Windows) from a genuine PowerShell error.
class RemoteBrowseError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message)
    this.name = 'RemoteBrowseError'
  }
}

// Why: relay fs.readDir needs workspace-root ACLs that don't exist until a repo is added, so browse over raw SSH exec.
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
        // Why: only a RemoteBrowseError (ran, non-zero exit) signals a Windows shell; don't retry transport errors/timeouts as Windows.
        if (!(posixError instanceof RemoteBrowseError)) {
          throw posixError
        }
        try {
          return await browseWithWindowsPowerShell(conn, args.dirPath)
        } catch (fallbackError) {
          // Why: exit 127 (no powershell.exe) → host isn't Windows, surface the original POSIX failure; otherwise PowerShell's own error is the real cause.
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
  // Why: `command ls` skips aliases; `&&` makes a failing ls exit non-zero (not look empty); -1Ap = one-per-line + trailing / on dirs.
  return runBrowseCommand(conn, `cd ${shellEscape(dirPath)} && pwd && command ls -1Ap`)
}

function browseWithWindowsPowerShell(
  conn: SshBrowseConnection,
  dirPath: string
): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Why: PowerShell 5.1 emits redirected stdout in the OEM code page; pin UTF-8 so non-ASCII names aren't mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$dir = ${powerShellPathExpression(dirPath)}`,
    'Set-Location -LiteralPath $dir',
    '$resolved = (Get-Location).ProviderPath',
    // Why: the renderer's parentPath/joinPath split only on `/`, so emit a forward-slash resolvedPath while keeping native $resolved for Get-ChildItem.
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
      // Why: no relay deadline exists during add-project browsing, so bound this raw exec channel or Add Remote Project hangs forever.
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
    // `exit` fires before `close`; capture the code to tell a failed `ls` (that still printed `pwd`) from an empty listing.
    const onExit = (code: number | null): void => {
      exitCode = code
    }
    const onError = (error: Error): void => {
      rejectOnce(error)
    }
    const onClose = (): void => {
      // Why: a null exitCode (channel closed without exit status) isn't success; don't treat empty stdout as an empty dir.
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

      // Why: Windows OpenSSH exec emits CRLF; split on \r?\n so a trailing \r doesn't defeat the endsWith('/') dir check or leave a stray CR in names.
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
    // Why: SSH exec streams emit `error` on transport loss; without a scoped listener a disappearing remote can become process-fatal.
    channel.on('error', onError)
    channel.stderr.on('error', onError)
    timeout = setTimeout(onTimeout, SSH_BROWSE_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}

// Why: exit 127 means powershell.exe wasn't found — the host isn't Windows, so surface the original POSIX failure instead.
function isPosixCommandNotFound(error: unknown): boolean {
  return error instanceof RemoteBrowseError && error.exitCode === POSIX_COMMAND_NOT_FOUND_EXIT
}

// Why: single-quote to block shell injection; ~ needs $HOME since single quotes suppress tilde expansion.
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

// Why: renderer's POSIX path rebuild yields '/C:/…' or bare 'C:' (drive-relative), both mis-resolved by Set-Location; re-root to a proper drive path.
function normalizeWindowsDrivePath(s: string): string {
  const stripped = s.replace(/^\/(?=[A-Za-z]:(?:[/\\]|$))/, '')
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped
}
