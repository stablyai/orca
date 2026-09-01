// Conservative payload caps applied after env composition. These do not replace
// a lower provider limit (which stays spawn_failed); they fail closed before a
// writer runs so persisted/remote data and inherited env size cannot smuggle an
// oversized command or environment past resolution.

import { Buffer } from 'node:buffer'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { buildShellCommandFromArgv } from '../../shared/tui-agent-startup-shell'
import {
  CMD_EXE_COMMAND_LINE_MAX_CHARS,
  POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS
} from '../providers/windows-shell-args'
import { utf8ByteLength } from '../../shared/custom-tui-agent-fields'
import type { AgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { AgentArgv } from '../../shared/agent-launch-host-contract'
import {
  measurePosixArgEnvBytes,
  measureWindowsEnvironmentBlockCodeUnits,
  POSIX_ARG_ENV_SAFE_MAX_BYTES,
  POSIX_STARTUP_COMMAND_MAX_BYTES,
  WINDOWS_ENVIRONMENT_BLOCK_MAX_CODE_UNITS,
  type EnvLayer
} from './compose-agent-launch-env'

/** PowerShell -EncodedCommand is base64 of the UTF-16LE command; this mirrors
 *  that length so the hard OS command-line ceiling is enforced pre-spawn. */
function estimatePowerShellEncodedLength(commandText: string): number {
  return Math.ceil(Buffer.byteLength(commandText, 'utf16le') / 3) * 4
}

/** Reject a command whose final shell form exceeds the target's hard OS limit.
 *  The 6000-char inline threshold is a delivery-path switch, not a failure, and
 *  lives in the startup writer (U3). */
export function checkCommandTooLong(
  argv: AgentArgv,
  shell: AgentStartupShell
): AgentLaunchFailure | null {
  const commandText = buildShellCommandFromArgv(argv, shell)
  if (shell === 'cmd') {
    return commandText.length > CMD_EXE_COMMAND_LINE_MAX_CHARS
      ? { code: 'launch_command_too_long', shell }
      : null
  }
  if (shell === 'powershell') {
    return estimatePowerShellEncodedLength(commandText) > POWERSHELL_ENCODED_COMMAND_ARG_MAX_CHARS
      ? { code: 'launch_command_too_long', shell }
      : null
  }
  return utf8ByteLength(commandText) > POSIX_STARTUP_COMMAND_MAX_BYTES
    ? { code: 'launch_command_too_long', shell }
    : null
}

/** Reject an oversized effective environment. Native-Windows spawns measure the
 *  CreateProcess environment block; every other target measures the combined
 *  UTF-8 argv+env payload delivered as shell text. */
export function checkEnvPayloadTooLarge(
  argv: AgentArgv,
  env: EnvLayer,
  target: { platform: NodeJS.Platform; execution: 'native' | 'wsl'; isRemote: boolean }
): AgentLaunchFailure | null {
  const isNativeWindowsSpawn =
    target.platform === 'win32' && target.execution === 'native' && !target.isRemote
  if (isNativeWindowsSpawn) {
    return measureWindowsEnvironmentBlockCodeUnits(env) > WINDOWS_ENVIRONMENT_BLOCK_MAX_CODE_UNITS
      ? { code: 'invalid_agent_env', field: 'env', reason: 'environment_block_too_large' }
      : null
  }
  return measurePosixArgEnvBytes(argv, env) > POSIX_ARG_ENV_SAFE_MAX_BYTES
    ? { code: 'invalid_agent_env', field: 'env', reason: 'arg_env_too_large' }
    : null
}
