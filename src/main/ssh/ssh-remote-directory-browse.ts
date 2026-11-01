import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { SshConnectionManager } from './connection/ssh-connection-manager'
import type { SshExecOptions } from './connection/ssh-exec-options'
import { powerShellCommand } from './ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../shared/powershell-native-argument'
import type { FilesystemPathFlavor } from '../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../shared/file-name-sort'
import { buildPosixStdoutFence } from '../../shared/posix-stdout-fence'

type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

export type RemoteBrowseResult = {
  entries: RemoteDirEntry[]
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
}

const SSH_BROWSE_TIMEOUT_MS = 15_000

// Exit 127 means PowerShell never ran; keep the original POSIX failure.
const POSIX_COMMAND_NOT_FOUND_EXIT = 127

// Preserve exit status so fallback distinguishes missing PowerShell from its own actual failure.
class RemoteBrowseError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message)
    this.name = 'RemoteBrowseError'
  }
}

// Browse via raw exec before repo-add because relay fs.readDir needs workspace-root ACLs.
export async function browseSshDirectory(
  manager: SshConnectionManager | null,
  targetId: string,
  dirPath: string
): Promise<RemoteBrowseResult> {
  if (!manager) {
    throw new Error('SSH connection manager not initialized')
  }
  const conn = manager.getConnection(targetId)
  if (!conn) {
    throw new Error(`SSH connection "${targetId}" not found`)
  }

  try {
    return await browseWithPosixShell(conn, dirPath)
  } catch (posixError) {
    // Only a host-answered nonzero exit permits Windows fallback; never reinterpret lost contact as host dialect.
    if (!(posixError instanceof RemoteBrowseError)) {
      throw posixError
    }
    try {
      return await browseWithWindowsPowerShell(conn, dirPath)
    } catch (fallbackError) {
      // Missing PowerShell preserves POSIX failure; otherwise surface the actual PowerShell error.
      throw isPosixCommandNotFound(fallbackError) ? posixError : fallbackError
    }
  }
}

const POSIX_LIST_WITH_DIR_MARKERS =
  'entries=$(command ls -1A) && printf \'%s\\n\' "$entries" | while IFS= read -r f; do ' +
  'if [ -d "$f" ]; then printf \'%s/\\n\' "$f"; else printf \'%s\\n\' "$f"; fi; done'

type SshBrowseConnection = NonNullable<ReturnType<SshConnectionManager['getConnection']>>

function browseWithPosixShell(
  conn: SshBrowseConnection,
  dirPath: string
): Promise<RemoteBrowseResult> {
  // Bypass ls aliases and propagate listing failure; test -d follows valid directory symlinks unlike ls -p.
  return runBrowseCommand(
    conn,
    `cd ${shellEscape(dirPath)} && pwd && ${POSIX_LIST_WITH_DIR_MARKERS}`,
    'posix'
  )
}

function browseWithWindowsPowerShell(
  conn: SshBrowseConnection,
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
    // Pin redirected UTF-8; PowerShell 5.1 defaults to OEM encoding.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$dir = ${powerShellPathExpression(dirPath)}`,
    'Set-Location -LiteralPath $dir',
    '$resolved = (Get-Location).ProviderPath',
    // Emit renderer-friendly forward slashes but retain native resolved path for Get-ChildItem.
    "Write-Output ($resolved -replace '\\\\', '/')",
    'Get-ChildItem -LiteralPath $resolved -Force | ForEach-Object {',
    "  if ($_.PSIsContainer) { Write-Output ($_.Name + '/') } else { Write-Output $_.Name }",
    '}'
  ].join('; ')

  return runBrowseCommand(conn, powerShellCommand(script), 'win32', { wrapCommand: false })
}

async function runBrowseCommand(
  conn: SshBrowseConnection,
  command: string,
  pathFlavor: FilesystemPathFlavor,
  options?: SshExecOptions
): Promise<RemoteBrowseResult> {
  // Fence startup stdout so login banners cannot become resolved paths.
  const fence = options?.wrapCommand === false ? null : buildPosixStdoutFence(command, 'SSH')
  const remoteCommand = fence?.command ?? command
  const channel = options ? await conn.exec(remoteCommand, options) : await conn.exec(remoteCommand)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let exitObserved = false
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
      } catch {}
    }
    const onTimeout = (): void => {
      // No relay deadline exists before project-add; bound raw exec so browsing cannot hang forever.
      rejectOnce(new Error('Remote directory listing timed out'))
      closeChannel()
    }
    const resolveOnce = (result: RemoteBrowseResult): void => {
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
    // Capture exit before close to distinguish failed ls plus successful pwd from empty directory.
    const onExit = (code: number | null): void => {
      exitObserved = true
      exitCode = code
    }
    const onError = (error: Error): void => {
      rejectOnce(error)
    }
    const onClose = (code?: number | null): void => {
      // ssh2 may emit exit before exec resolves; close repeats status.
      if (!exitObserved && typeof code === 'number') {
        exitCode = code
      }
      stdout = fence?.readStdout(stdout) ?? stdout
      // Missing exit status is unknown, never successful empty directory.
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

      // Split Windows CRLF so carriage returns cannot corrupt names or directory suffix checks.
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

      sortDirEntries(entries)

      resolveOnce({ entries, resolvedPath, pathFlavor })
    }

    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('exit', onExit)
    channel.on('close', onClose)
    // Own channel/stderr errors so disappearing hosts cannot crash main.
    channel.on('error', onError)
    channel.stderr.on('error', onError)
    timeout = setTimeout(onTimeout, SSH_BROWSE_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}

// PowerShell-not-found means the Windows fallback never ran.
function isPosixCommandNotFound(error: unknown): boolean {
  return error instanceof RemoteBrowseError && error.exitCode === POSIX_COMMAND_NOT_FOUND_EXIT
}

// Quote against injection, substituting HOME explicitly because single quotes suppress tilde expansion.
function shellEscape(s: string): string {
  if (s === '~') {
    return '"$HOME"'
  }
  if (s.startsWith('~/')) {
    return `"$HOME"/${quotePosixShell(s.slice(2))}`
  }
  return quotePosixShell(s)
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

// Normalize renderer /C:/ and drive-relative C: to rooted Windows paths before Set-Location.
function normalizeWindowsDrivePath(s: string): string {
  const stripped = s.replace(/^\/(?=[A-Za-z]:(?:[/\\]|$))/, '')
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped
}
