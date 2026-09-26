import { basename } from 'node:path'
import { resolveDefaultShell } from './pty-shell-utils'
import { buildCapturedShellCommand } from '../shared/wsl-login-shell-command'

export function agentExecLoginShell(
  binary: string,
  args: string[],
  cwd: string | undefined,
  requested: unknown,
  env: NodeJS.ProcessEnv = {}
): {
  spawnCmd: string
  spawnArgs: string[]
  readStdout: (stdout: string) => string | null
  isMissingBinary: (stdout: string, exitCode: number | null) => boolean
} | null {
  if (process.platform === 'win32' || requested !== true) {
    return null
  }
  const shell = resolveDefaultShell()
  if (!['bash', 'zsh'].includes(basename(shell).toLowerCase())) {
    return null
  }

  const captured = buildCapturedShellCommand('cd -- "$1" || exit; shift; exec "$@"')
  // A per-call marker distinguishes a missing binary from an agent's own exit 127.
  const missingMarker = captured.beginMarker.replace('CAPTURE_BEGIN', 'AGENT_NOT_FOUND')
  // Apply explicit values after startup files have populated the login environment.
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${value}`)
  return {
    spawnCmd: shell,
    spawnArgs: [
      '-ilc',
      captured.command,
      'orca-agent',
      cwd ?? process.cwd(),
      '/usr/bin/env',
      '--',
      ...assignments,
      '/bin/sh',
      '-c',
      'command -v "$1" >/dev/null 2>&1 || { printf %s "$0"; exit 127; }; exec "$@"',
      missingMarker,
      binary,
      ...args
    ],
    readStdout: captured.readStdout,
    isMissingBinary: (stdout, exitCode) => exitCode === 127 && stdout === missingMarker
  }
}
