import { exec, execFile } from 'node:child_process'
import { isWslPath, parseWslPath, toLinuxPath } from './wsl'

export const SERVICE_COMMAND_TIMEOUT_MS = 600_000
// Why: status probes run on every panel open; a hung probe must not sit for 10 minutes.
export const SERVICE_STATUS_TIMEOUT_MS = 30_000

export type ServiceCommandResult = { success: boolean; output: string }
export type ServiceCommandStreamHandler = (stream: 'stdout' | 'stderr', chunk: string) => void

// Why: raw create/destroy output is persisted and surfaced in the UI; service
// commands routinely print connection strings and credentials, so scrub the
// obvious secret shapes and cap the size before anything leaves this module.
export function sanitizeServiceCommandOutput(text: string): string {
  return text
    .replace(/(\w+:\/\/[^\s:@/]+):[^\s@/]+@/g, '$1:[redacted]@')
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|access[_-]?key)\s*[=:]\s*)\S+/gi,
      '$1[redacted]'
    )
    .slice(0, 2000)
}

function getServiceShell(): string {
  return process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash'
}

export function runServiceCommand(
  command: string,
  worktreePath: string,
  env: Record<string, string>,
  onChunk?: ServiceCommandStreamHandler,
  timeoutMs: number = SERVICE_COMMAND_TIMEOUT_MS
): Promise<ServiceCommandResult> {
  const wslInfo = isWslPath(worktreePath) ? parseWslPath(worktreePath) : null
  if (wslInfo) {
    return runServiceCommandWsl(command, wslInfo, env, onChunk, timeoutMs)
  }
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: worktreePath,
        shell: getServiceShell(),
        timeout: timeoutMs,
        env: { ...process.env, ...env }
      },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: [stdout, stderr, error ? String(error.message) : ''].filter(Boolean).join('\n')
        })
      }
    )
    child.stdout?.on('data', (chunk: string) => onChunk?.('stdout', String(chunk)))
    child.stderr?.on('data', (chunk: string) => onChunk?.('stderr', String(chunk)))
  })
}

function runServiceCommandWsl(
  command: string,
  wslInfo: { distro: string; linuxPath: string },
  env: Record<string, string>,
  onChunk?: ServiceCommandStreamHandler,
  timeoutMs: number = SERVICE_COMMAND_TIMEOUT_MS
): Promise<ServiceCommandResult> {
  // Why: route through wsl.exe (not exec/cmd.exe) so WSL worktree commands are
  // not mangled by the Windows shell. Only the cwd is single-quote escaped —
  // the command goes verbatim into `bash -c`, where escaping it would corrupt
  // legitimate quoting inside the recipe.
  const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
  const bashCmd = `cd '${escapedCwd}' && ${command}`
  const wslEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    wslEnv[key] = toLinuxPath(value)
  }
  // Why: wsl.exe only imports Windows env vars named in WSLENV; without this
  // the ORCA_* context and recipe env would never reach the WSL session.
  const passthrough = Object.keys(env)
    .map((key) => `${key}/u`)
    .join(':')
  wslEnv.WSLENV = process.env.WSLENV ? `${process.env.WSLENV}:${passthrough}` : passthrough
  return new Promise((resolve) => {
    const distroArgs = wslInfo.distro ? ['-d', wslInfo.distro] : []
    const child = execFile(
      'wsl.exe',
      [...distroArgs, '--', 'bash', '-c', bashCmd],
      {
        timeout: timeoutMs,
        encoding: 'utf-8',
        env: { ...process.env, ...wslEnv }
      },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: [stdout, stderr, error ? String(error.message) : ''].filter(Boolean).join('\n')
        })
      }
    )
    child.stdout?.on('data', (chunk: string) => onChunk?.('stdout', String(chunk)))
    child.stderr?.on('data', (chunk: string) => onChunk?.('stderr', String(chunk)))
  })
}
