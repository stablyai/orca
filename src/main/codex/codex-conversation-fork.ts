import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { isAgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { codexStructuredPermissionPolicy } from '../../shared/codex-permission-policy'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { requireCodexForkCutSupport } from './codex-fork-cut-support'
import { forkCodexThread } from './codex-thread-fork'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export async function materializeCodexConversationFork(
  deps: CodexStructuredSessionAdapterDeps,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['forkConversation']>>[0],
  live?: CodexSession
): ReturnType<NonNullable<StructuredAgentSessionAdapter['forkConversation']>> {
  const { record } = input
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!deps.readLaunch || record.provider !== 'codex' || head?.handle.agent !== 'codex') {
    throw new Error('The parent Codex conversation is unavailable for branching.')
  }
  throwIfSignalAborted(input.signal)
  const launch = await deps.readLaunch({
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: record.location.executionHostId,
    agent: 'codex',
    providerHandle: head.handle
  })
  if (record.launchArgs) {
    launch.args = [
      ...(launch.prefixArgs ?? []),
      ...codexStructuredLaunchArgs(record.launchArgs),
      'app-server'
    ]
  }
  await requireCodexForkCutSupport(launch)
  throwIfSignalAborted(input.signal)
  const connection = await (deps.openConnection ?? openCodexAppServerConnection)(launch)
  let forked: Awaited<ReturnType<typeof forkCodexThread>>
  let closed = false
  try {
    const permissionMode = isAgentChatPermissionChoice(record.permissionMode)
      ? record.permissionMode
      : 'ask'
    forked = await forkCodexThread({
      ...input,
      connection,
      threadId: head.handle.nativeId,
      cwd: launch.cwd,
      ...(permissionMode === 'own'
        ? { ownPermissionHome: requireLegacyAgentSessionAccountHome(record.accountHome).path }
        : { permissionPolicy: codexStructuredPermissionPolicy(permissionMode) }),
      options: { ...live?.appliedTurnOptions, ...record.options },
      timeoutMs: deps.requestTimeoutMs
    })
  } finally {
    closed = await connection.close()
  }
  if (!closed) {
    throw new Error('The Codex branch connection could not be closed; its outcome is unknown.')
  }
  return forked
}
