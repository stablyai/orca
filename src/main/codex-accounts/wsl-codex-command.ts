import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  buildWslLoginShellCommand,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'

export const WSL_CODEX_AVAILABILITY_TIMEOUT_MS = 5_000
export const WSL_CODEX_NOT_FOUND_MESSAGE = 'Codex CLI not found in the WSL login-shell PATH.'

/** Exits 0 only when `codex` resolves on the login PATH the runner supplies. */
export function buildWslCodexAvailabilityScript(): string {
  return [buildCodexPathLookup(), '[ -n "$resolved" ]'].join('\n')
}

export type WslCodexIdentityProbe = {
  args: string[]
  /** The `<path>\n<version>` payload, or null when the fence never appeared. */
  readStdout: (stdout: string) => string | null
}

/**
 * Probe the distro's Codex path and version.
 *
 * Why fenced: this reads the login shell's stdout positionally (path before the
 * first newline, version after), and an interactive login shell prints the
 * distro rc/motd to stdout ahead of it — which silently moves that split into
 * the banner. The payload ends in `exec`, so no closing fence is ever written;
 * `readStdout` returns everything after the opening one.
 */
export function buildWslCodexIdentityProbe(distro: string): WslCodexIdentityProbe {
  const command = [
    buildCodexPathLookup(),
    'if [ -z "$resolved" ]; then',
    `  printf '%s\\n' '${WSL_CODEX_NOT_FOUND_MESSAGE}' >&2`,
    '  exit 127',
    'fi',
    'printf \'%s\\n\' "$resolved"',
    'exec "$resolved" --version'
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(command)
  return {
    args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
    readStdout: captured.readStdout
  }
}

export function buildWslCodexAppServerArgs(
  distro: string,
  linuxHomePath: string,
  appServerArgs: readonly string[] = ['app-server']
): string[] {
  const command = [
    buildCodexPathLookup(),
    'if [ -z "$resolved" ]; then',
    `  printf '%s\\n' '${WSL_CODEX_NOT_FOUND_MESSAGE}' >&2`,
    '  exit 127',
    'fi',
    `export CODEX_HOME=${quotePosixShell(linuxHomePath)}`,
    `exec "$resolved" ${appServerArgs.map(quotePosixShell).join(' ')}`
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
  // Same skip as agent detection: otherwise detection can report the guest
  // codex while this resolves the Windows one ahead of it on PATH, and Orca
  // launches a different binary than the one it said was installed.
  return buildPosixCommandPathLookupScript(
    { kind: 'literal', value: 'codex' },
    { skipWindowsMountDirs: true }
  )
}

function buildWslCodexShellArgs(distro: string, command: string): string[] {
  // Why: Codex must use the distro user's configured login shell, whose PATH
  // can differ from a hard-coded non-login bash invocation.
  return buildWslExecArgs(distro, ['sh', '-c', buildWslLoginShellCommand(command)])
}
