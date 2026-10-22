import { homedir } from 'node:os'
import { readUserClaudeConfigDir, resolveClaudeDefaultHome } from '../../shared/claude-user-config'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

export type SystemClaudeHookTarget = { kind: 'system-default'; configDir: string }

export type ClaudeHookTarget =
  | SystemClaudeHookTarget
  | { kind: 'profile'; configDir: string; systemDefaultConfigDir?: string }

export type ManagedHookInvocation = { env?: NodeJS.ProcessEnv }

export function systemClaudeHookTarget(
  env: NodeJS.ProcessEnv = process.env
): SystemClaudeHookTarget {
  return {
    kind: 'system-default',
    configDir: resolveClaudeDefaultHome(homedir(), readUserClaudeConfigDir(env))
  }
}

/** Explicit CLI context must not be overwritten by another shell's startup files. */
export async function resolveSystemClaudeHookTarget(
  invocation: ManagedHookInvocation = {}
): Promise<SystemClaudeHookTarget> {
  return systemClaudeHookTarget(invocation.env ?? (await resolveLoginShellEnvironment()))
}
