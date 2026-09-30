import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshExecOptions } from '../ssh/ssh-connection-utils'
import { captureSshExecChannel, type SshExecConnection } from '../ssh/ssh-exec-channel-capture'
import { powerShellCommand, powerShellLiteral } from '../ssh/ssh-remote-powershell'
import type { FilesystemPathFlavor } from '../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../shared/file-name-sort'

export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

type RemoteBrowseResult = {
  entries: RemoteDirEntry[]
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
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
    async (_event, args: { targetId: string; dirPath: string }): Promise<RemoteBrowseResult> => {
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

function browseWithPosixShell(
  conn: SshExecConnection,
  dirPath: string
): Promise<RemoteBrowseResult> {
  // Why: `command ls` skips aliases; `&&` makes a failing ls exit non-zero (not look empty); -1Ap = one-per-line + trailing / on dirs.
  return runBrowseCommand(conn, `cd ${shellEscape(dirPath)} && pwd && command ls -1Ap`, 'posix')
}

function browseWithWindowsPowerShell(
  conn: SshExecConnection,
  dirPath: string
): Promise<RemoteBrowseResult> {
  if (/^[\\/]+$/.test(dirPath.trim())) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Write-Output '/'",
      "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -match '^[A-Za-z]$' } | Sort-Object Name | ForEach-Object { Write-Output (($_.Name.ToUpperInvariant() + ':\\') + '/') }"
    ].join('; ')
    return runBrowseCommand(conn, powerShellCommand(script), 'win32', { wrapCommand: false })
  }

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

  return runBrowseCommand(conn, powerShellCommand(script), 'win32', { wrapCommand: false })
}

async function runBrowseCommand(
  conn: SshExecConnection,
  command: string,
  pathFlavor: FilesystemPathFlavor,
  options?: SshExecOptions
): Promise<RemoteBrowseResult> {
  const { stdout, stderr, exitCode } = await captureSshExecChannel(conn, command, {
    timeoutMs: SSH_BROWSE_TIMEOUT_MS,
    timeoutMessage: 'Remote directory listing timed out',
    execOptions: options
  })

  // Why: a null exitCode (channel closed without exit status) isn't success; don't treat empty stdout as an empty dir.
  if (exitCode !== 0) {
    const msg =
      stderr.trim() ||
      (exitCode === null
        ? 'Remote listing failed (channel closed without exit status)'
        : `Remote listing failed (exit ${exitCode})`)
    throw new RemoteBrowseError(msg, exitCode)
  }
  if (stderr.trim() && !stdout.trim()) {
    throw new Error(stderr.trim())
  }

  // Why: Windows OpenSSH exec emits CRLF; split on \r?\n so a trailing \r doesn't defeat the endsWith('/') dir check or leave a stray CR in names.
  const lines = stdout.trim().split(/\r?\n/)
  if (lines.length === 0) {
    throw new Error('Empty response from remote')
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

  // Sort: directories first, then natural name order (matches the Explorer)
  sortDirEntries(entries)

  return { entries, resolvedPath, pathFlavor }
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
