import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'

export const WSL_CODEX_AVAILABILITY_TIMEOUT_MS = 5_000

export function buildWslCodexAvailabilityArgs(distro: string): string[] {
  const command = [buildCodexPathLookup(), '[ -n "$resolved" ]'].join('\n')
  return buildWslCodexShellArgs(distro, command)
}

export function buildWslCodexIdentityArgs(distro: string): string[] {
  const command = [
    buildCodexPathLookup(),
    'if [ -z "$resolved" ]; then',
    "  printf '%s\\n' 'Codex CLI not found in the WSL login-shell PATH.' >&2",
    '  exit 127',
    'fi',
    'printf \'%s\\n\' "$resolved"',
    'exec "$resolved" --version'
  ].join('\n')
  return buildWslCodexShellArgs(distro, command)
}

export function buildWslCodexAppServerArgs(distro: string, linuxHomePath: string): string[] {
  const command = [
    buildCodexPathLookup(),
    'if [ -z "$resolved" ]; then',
    "  printf '%s\\n' 'Codex CLI not found in the WSL login-shell PATH.' >&2",
    '  exit 127',
    'fi',
    `export CODEX_HOME=${quotePosixShell(linuxHomePath)}`,
    'exec "$resolved" app-server'
  ].join('\n')
  return buildWslCodexShellArgs(distro, command)
}

export function buildWslCodexLoginArgs(distro: string, linuxHomePath: string): string[] {
  const command = [
    buildCodexPathLookup(),
    'if [ -z "$resolved" ]; then',
    "  printf '%s\\n' 'Codex CLI not found in the WSL login-shell PATH.' >&2",
    '  exit 127',
    'fi',
    `export CODEX_HOME=${quotePosixShell(linuxHomePath)}`,
    'exec "$resolved" login'
  ].join('\n')
  return buildWslCodexShellArgs(distro, command)
}

function buildCodexPathLookup(): string {
  return buildPosixCommandPathLookupScript({ kind: 'literal', value: 'codex' })
}

function buildWslCodexShellArgs(distro: string, command: string): string[] {
  // Why: Codex must use the distro user's configured login shell, whose PATH
  // can differ from a hard-coded non-login bash invocation.
  return [
    '-d',
    distro,
    '--',
    'sh',
    '-c',
    escapeWslShCommandForWindows(buildWslLoginShellCommand(command))
  ]
}
