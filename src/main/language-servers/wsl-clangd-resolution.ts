// WSL clangd binary discovery + version gate (spec D7/D8). The binary lives
// in the guest's PATH, so discovery runs a one-shot POSIX PATH lookup inside
// the distro (reusing `buildPosixCommandPathLookupScript`); the version gate
// runs `clangd --version` through the same shell-free lane. Both are one-shot
// captured probes — the capture-fence prohibition (spec D8) applies only to
// the long-lived clangd, never to these probes.
//
// The long-lived spawn itself goes through `wsl.exe --exec` with the cached
// guest environment (PATH/HOME) prepended via the `env` binary — no login
// shell, no capture fence, stdio pipes straight through wsl.exe (spec D8).
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import type { WslGuestEnvironment } from '../wsl/wsl-guest-environment'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { runProcess } from '../../shared/child-process/run-process'
import {
  parseClangdVersion,
  classifyClangdVersion,
  CLANGD_INSTALL_HINT,
  type ClangdVersionGateResult
} from './clangd-launch'

const CLANGD_PATH_PROBE_TIMEOUT_MS = 5_000
const CLANGD_VERSION_PROBE_TIMEOUT_MS = 5_000
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Build the guest argv that resolves `clangd` on the login PATH, byte-for-byte.
 *
 * Why shell-free + env prefix (not the login-shell capture fence): the cached
 * guest environment already carries the user's real PATH (nvm/mise/asdf), so a
 * non-login `sh -c` on that PATH finds the same binary the user's terminal
 * would — without the rc/motd banner noise the capture fence exists to strip.
 * The lookup script sets `resolved=`; this prints it (empty when not found).
 */
function buildClangdPathProbeScript(): string {
  return [
    buildPosixCommandPathLookupScript(
      { kind: 'literal', value: 'clangd' },
      { skipWindowsMountDirs: true }
    ),
    'printf %s "$resolved"'
  ].join('\n')
}

/**
 * Spawn argv for the long-lived clangd inside the guest, shell-free.
 *
 * `wsl.exe -d <distro> --exec <env> PATH=<guest PATH> HOME=<guest HOME> <clangd> <args>`
 * — the `env` binary applies the cached PATH/HOME without a shell, so wsl.exe's
 * pipes carry clangd's stdio directly (spec D8: no shell, no capture fence).
 * When the guest environment probe failed (null), clangd runs on the distro's
 * default PATH (degraded: an nvm-installed clangd is invisible, but
 * /usr/bin/clangd still resolves).
 */
export function buildWslClangdSpawnArgs(
  distro: string | undefined,
  environment: WslGuestEnvironment | null,
  clangdPath: string,
  clangdArgs: readonly string[]
): string[] {
  const command = environment
    ? [
        environment.envBinary,
        `PATH=${environment.path}`,
        `HOME=${environment.home}`,
        clangdPath,
        ...clangdArgs
      ]
    : [clangdPath, ...clangdArgs]
  return buildWslExecArgs(distro, command)
}

/** Host env for the wsl.exe spawn (WSL_UTF8 so wsl.exe's own messages are readable). */
export function buildWslHostEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WSL_UTF8: '1' }
}

/** Resolve clangd's guest PATH; null when the probe could not reach the distro. */
export async function resolveWslClangdPath(
  distro: string | undefined,
  environment: WslGuestEnvironment | null,
  runProcessImpl: typeof runProcess = runProcess
): Promise<string | null> {
  if (!environment) {
    // No cached guest PATH: probe on the distro's default PATH (no env prefix).
    return resolveWslClangdPathShellFree(distro, null, runProcessImpl)
  }
  return resolveWslClangdPathShellFree(distro, environment, runProcessImpl)
}

async function resolveWslClangdPathShellFree(
  distro: string | undefined,
  environment: WslGuestEnvironment | null,
  runProcessImpl: typeof runProcess
): Promise<string | null> {
  const guestArgv = environment
    ? [
        environment.envBinary,
        `PATH=${environment.path}`,
        `HOME=${environment.home}`,
        'sh',
        '-c',
        buildClangdPathProbeScript()
      ]
    : ['sh', '-c', buildClangdPathProbeScript()]
  let result
  try {
    result = await runProcessImpl({
      program: resolveWslExecutablePath(),
      args: buildWslExecArgs(distro, guestArgv),
      cwd: resolveWslInteropSpawnCwd(),
      env: buildWslHostEnv(),
      timeoutMs: CLANGD_PATH_PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })
  } catch {
    return null
  }
  if (result.timedOut || result.code !== 0) {
    return null
  }
  const resolved = result.stdout.trim()
  return resolved === '' ? null : resolved
}

/**
 * Probe + classify the guest clangd version. Runs `clangd --version` through
 * the same shell-free lane. Never rejects — a missing binary or bad banner
 * resolves to a `reject` with the install hint (spec D7).
 */
export async function resolveWslClangdVersionGate(
  distro: string | undefined,
  environment: WslGuestEnvironment | null,
  clangdPath: string,
  runProcessImpl: typeof runProcess = runProcess
): Promise<ClangdVersionGateResult> {
  const guestArgv = environment
    ? [
        environment.envBinary,
        `PATH=${environment.path}`,
        `HOME=${environment.home}`,
        clangdPath,
        '--version'
      ]
    : [clangdPath, '--version']
  let result
  try {
    result = await runProcessImpl({
      program: resolveWslExecutablePath(),
      args: buildWslExecArgs(distro, guestArgv),
      cwd: resolveWslInteropSpawnCwd(),
      env: buildWslHostEnv(),
      timeoutMs: CLANGD_VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })
  } catch {
    return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
  }
  if (result.timedOut) {
    return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
  }
  const major = parseClangdVersion(result.stdout)
  const kind = classifyClangdVersion(major)
  return { kind, major, message: messageForGate(kind, major) }
}

function messageForGate(
  kind: 'ok' | 'suggest-upgrade' | 'reject',
  major: number | null
): string | null {
  if (kind === 'ok') {
    return null
  }
  if (kind === 'suggest-upgrade') {
    return `clangd ${major} works but navigation is best on clangd 16+; consider an upgrade inside the WSL distro (\`sudo apt install clangd\` or equivalent).`
  }
  return major === null
    ? CLANGD_INSTALL_HINT
    : `clangd ${major} is below the supported floor of 12. ${CLANGD_INSTALL_HINT}`
}
