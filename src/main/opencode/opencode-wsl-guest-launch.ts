import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import {
  buildWslCapturedLoginShellCommand,
  buildWslLoginShellCommand
} from '../../shared/wsl-login-shell-command'
import type { SourceControlAgentSpawnInput } from '../text-generation/source-control-text-generation-types'

const TASK_ENV_PREFIX = 'ORCA_OPENCODE_TASK_ENV_'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Re-enter the guest login shell for the selected OpenCode, as the CLI route did: profile functions
 * and rc account setup resolve again, then inline assignments and task-private values apply last.
 */
export function guestLoginShellLaunch(
  input: SourceControlAgentSpawnInput,
  baseEnv: NodeJS.ProcessEnv,
  commandEnv: Readonly<Record<string, string>>,
  privateEnv: Readonly<Record<string, string>> = {},
  captureVersion = false
): SourceControlAgentSpawnInput & {
  env: NodeJS.ProcessEnv
  readStdout?: (stdout: string) => string | null
} {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...input.env }
  const restore: string[] = []
  for (const [key, value] of Object.entries(privateEnv)) {
    if (!ENV_NAME.test(key)) {
      throw new Error('OpenCode task environment name is invalid')
    }
    // Private values (server credentials) travel by environment, never argv, and outrank rc files.
    env[`${TASK_ENV_PREFIX}${key}`] = value
    restore.push(
      `${key}="$${TASK_ENV_PREFIX}${key}"; export ${key}; unset ${TASK_ENV_PREFIX}${key}; `
    )
  }
  const assignments = Object.entries(commandEnv)
    .filter(([key]) => !Object.hasOwn(privateEnv, key))
    .map(([key, value]) => `${key}=${value}`)
  // Same command text as the CLI route, so a profile function named like the binary still resolves.
  const command = assignments.length
    ? ['/usr/bin/env', ...assignments, input.binary, ...input.args]
    : [input.binary, ...input.args]
  const script = `${restore.join('')}cd ${quotePosixShell(input.cwd ?? '.')} && ${command
    .map(quotePosixShell)
    .join(' ')}`
  const captured = captureVersion ? buildWslCapturedLoginShellCommand(script) : undefined
  return {
    ...input,
    binary: '/bin/sh',
    args: ['-lc', captured?.command ?? buildWslLoginShellCommand(script)],
    env,
    ...(captured ? { readStdout: captured.readStdout } : {})
  }
}
