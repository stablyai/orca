import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session-record-launch-directory'
import { resolveHiddenProbeCwd } from '../rate-limits/hidden-probe-cwd'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'
import {
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import type { CodexSession } from './codex-structured-session-state'

export type CodexRenameInvocationDeps = CodexStructuredInvocationDeps & {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
}

async function renameCwd(
  record: AgentSessionRecord,
  deps: CodexRenameInvocationDeps
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

const RENAME_TIMEOUT_MS = 15_000
// Older Codex refuses a name until the thread's first record reaches disk; give a fresh
// conversation two short chances, then leave the name for the user's next rename.
const EMPTY_ROLLOUT = /\brollout at .+ is empty\b/i
const EMPTY_ROLLOUT_RETRY_DELAYS_MS = [50, 200] as const

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function setThreadName(
  request: CodexAppServerRpc['request'],
  threadId: string,
  name: string
): Promise<void> {
  for (const delay of EMPTY_ROLLOUT_RETRY_DELAYS_MS) {
    try {
      await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
      return
    } catch (error) {
      if (!(error instanceof Error) || !EMPTY_ROLLOUT.test(error.message)) {
        throw error
      }
      await wait(delay)
    }
  }
  await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
}

/** Codex's own /rename is `thread/name/set`. It names an unloaded thread straight in the
 *  account's thread store, so a chat at rest takes it from a short-lived app-server without
 *  resuming the thread. */
export async function renameCodexProviderSession(input: {
  session: CodexSession | undefined
  record: AgentSessionRecord
  providerSessionId: string
  name: string
  invocation?: CodexRenameInvocationDeps
}): Promise<void> {
  const { session, providerSessionId, name } = input
  const live = session && !session.ended && !session.connection.closed ? session : null
  if (live?.threadId === providerSessionId) {
    await setThreadName(
      (method, params, options) => live.connection.request(method, params, options),
      providerSessionId,
      name
    )
    return
  }
  const { record, invocation } = input
  if (
    record.provider !== 'codex' ||
    !supportsCodexStructuredLocation(record.location) ||
    !agentDrivesSession({ definition: () => CODEX_STRUCTURED_AGENT }, record)
  ) {
    throw new Error('unsupported Codex rename location, account or handles')
  }
  if (!invocation) {
    throw new Error('Codex rename invocation is not configured')
  }
  const codexHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const cwd = await renameCwd(record, invocation)
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
  await runCodexAppServerSession(
    {
      command,
      args: [...prefixArgs, ...args, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      cwd,
      cliPath: command,
      env: { ...env, CODEX_HOME: codexHome },
      envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
      timeoutMs: RENAME_TIMEOUT_MS
    },
    (rpc) => setThreadName(rpc.request, providerSessionId, name)
  )
}
