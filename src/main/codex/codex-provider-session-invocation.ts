import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session/records/agent-session-record-launch-directory'
import { resolveHiddenProbeCwd } from '../rate-limits/hidden-probe-cwd'
import { codexStructuredLaunchArgs } from './structured/launch/codex-structured-launch-args'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './structured/launch/codex-structured-launch-resolution'
import {
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

export type CodexProviderSessionInvocationDeps = CodexStructuredInvocationDeps & {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
}

async function conversationCwd(
  record: AgentSessionRecord,
  deps: CodexProviderSessionInvocationDeps
): Promise<string> {
  const cwd = resolve(
    agentSessionPinnedLaunchDirectory(record) ??
      (await deps.resolveWorkspacePath(record.location.workspaceId))
  )
  try {
    if ((await stat(cwd)).isDirectory()) {
      return cwd
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  return resolveHiddenProbeCwd()
}

export async function codexProviderSessionInvocation(
  record: AgentSessionRecord,
  invocation: CodexProviderSessionInvocationDeps,
  timeoutMs: number
) {
  const codexHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const cwd = await conversationCwd(record, invocation)
  const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
    ...invocation,
    resolveWorkingDirectory: () => cwd
  })
  const args = codexStructuredLaunchArgs(await invocation.resolveLaunchArgs())
  const env = Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  return {
    command,
    args: [...prefixArgs, ...args, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
    cwd,
    cliPath: command,
    env: { ...env, CODEX_HOME: codexHome },
    envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
    timeoutMs
  }
}
