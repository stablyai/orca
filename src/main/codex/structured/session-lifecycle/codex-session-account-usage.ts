import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import {
  runCodexAppServerSession,
  type CodexAppServerRpc
} from '../../app-server/codex-app-server-session'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../../../codex-cli/codex-read-only-app-server-args'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../../codex-cli/codex-home-process-lock'
import {
  CodexUsageApiKeyAuthError,
  mapCodexRpcRateLimits,
  type CodexAccountUsageRead,
  type RpcRateLimitsResponse
} from '../../../rate-limits/codex-rpc-rate-limit-mapper'
import { codexStructuredLaunchArgs } from '../launch/codex-structured-launch-args'
import { resolveCodexStructuredInvocation } from '../launch/codex-structured-launch-resolution'
import {
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
} from '../../../native-chat/native-chat-visuals-delivery'
import {
  codexProviderProbeCwd,
  type CodexProviderInvocationDeps
} from './codex-provider-session-rename'
import type { CodexSession } from './codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'

const USAGE_RPC_TIMEOUT_MS = 10_000
const COLD_USAGE_TIMEOUT_MS = 30_000

async function readUsage(
  request: CodexAppServerRpc['request']
): Promise<Omit<CodexAccountUsageRead, 'live'>> {
  const accountReply = await request('account/read', {}, { timeoutMs: USAGE_RPC_TIMEOUT_MS })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Codex's account/read response owns the account envelope.
  const { account } = (accountReply ?? {}) as Pick<CodexAccountUsageRead, 'account'>
  if (account?.type === 'apiKey') {
    throw new CodexUsageApiKeyAuthError()
  }
  const limits = await request('account/rateLimits/read', {}, { timeoutMs: USAGE_RPC_TIMEOUT_MS })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing mapper reads Codex's optional rate-limit response fields.
  return { account, rateLimits: mapCodexRpcRateLimits((limits ?? {}) as RpcRateLimitsResponse) }
}

/** Live chats read on their own connection; a chat at rest reads its pinned home through a
 *  short-lived app-server launched exactly as the chat is, without resuming the thread. */
export function readCodexSessionAccountUsage(
  sessions: Map<string, CodexSession>,
  readInvocation: () => CodexProviderInvocationDeps | undefined
): NonNullable<StructuredAgentSessionAdapter['readAccountUsage']> {
  return async (record, signal) => {
    const connection = sessions.get(record.sessionId)?.connection
    if (connection && !connection.closed) {
      const usage = await readUsage((method, params, options) =>
        connection.request(method, params, options)
      )
      return { ...usage, live: true }
    }
    const invocation = readInvocation()
    if (!invocation) {
      throw new Error('Codex usage invocation is not configured')
    }
    const codexHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
    return withCodexHomeProcessLock(resolveCodexHomeProcessLockKey(codexHome), async () => {
      signal.throwIfAborted()
      const cwd = await codexProviderProbeCwd(record, invocation)
      const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
        ...invocation,
        signal,
        resolveWorkingDirectory: () => cwd
      })
      const args = codexStructuredLaunchArgs(await invocation.resolveLaunchArgs())
      const env = Object.fromEntries(
        Object.entries(environment ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      return runCodexAppServerSession(
        {
          command,
          args: [...prefixArgs, ...args, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
          cwd,
          cliPath: command,
          env: { ...env, CODEX_HOME: codexHome },
          envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
          timeoutMs: COLD_USAGE_TIMEOUT_MS,
          signal
        },
        (rpc) => readUsage(rpc.request)
      )
    })
  }
}
