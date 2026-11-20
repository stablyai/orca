import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { translate } from '../i18n/mobile-i18n'
import { sessionTabCreateTerminal } from '../session/tabs/mobile-session-tab-write-operations'
import {
  handoffMobileHistorySession,
  type PendingMobileHistoryHandoff
} from './mobile-history-session-handoff'
import { agentHistoryHostStatusRead } from './mobile-agent-history-operations'
import { prepareMobileHistoryResumeTarget } from './mobile-history-resume-target-preparation'
import {
  buildMobileAiVaultResumeLaunch,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resumeAiVaultSessionInTerminal,
  type MobileAiVaultResumeMutationRegistry
} from './ai-vault-resume-launch'
import {
  prepareMobileAiVaultSessionResume,
  RESUME_RPC_TIMEOUT_MS
} from './ai-vault-resume-preparation'
import { terminalTabPaneKey } from '../session/tabs/notification-pane-tab'

export type MobileHistorySessionAction =
  | { kind: 'resume' }
  | { kind: 'cli' }
  | { kind: 'handoff'; agent: TuiAgent; worktreeId: string }

export type MobileHistoryContinuationDestination = {
  worktreeId: string
  paneKey?: string
  terminal?: string
  warning?: string
  contextToCopy?: string
}
export type MobileHistoryResumeResult = void | {
  kind: 'handoff-target-changed'
  session: AiVaultSession
}
export class MobileHistoryHandoffWorkspaceChanged extends Error {
  constructor(readonly session: AiVaultSession) {
    super(
      translate(
        'agentHistory.handoff.workspaceChanged',
        'The workspace changed. Choose an agent again.'
      )
    )
  }
}

type ContinuationContext = {
  client: RpcClient
  session: AiVaultSession
  worktreeId: string
  worktrees: readonly Worktree[]
  assertCurrentOwner: () => void
}

export async function loadMobileHistoryContinuationTarget(args: ContinuationContext) {
  const statusReply = await agentHistoryHostStatusRead.request(args.client)
  args.assertCurrentOwner()
  const status = interpretOrThrowRefusalMessage(
    () => agentHistoryHostStatusRead.interpret(statusReply),
    translate('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
  )
  const host = readMobileAiVaultResumeHost(status)
  const target = await prepareMobileHistoryResumeTarget({
    ...args,
    hostPlatform: host.platform,
    unknownPlatformMessage: () =>
      translate('agentHistory.panel.unknownHostPlatform', 'Unable to determine host platform.')
  })
  if (target.status !== 'ready') {
    throw new Error(target.message)
  }
  return { ...target, host, status }
}

export async function continueMobileHistorySession(
  args: ContinuationContext & {
    action: Exclude<MobileHistorySessionAction, { kind: 'resume' }>
    mutations: MobileAiVaultResumeMutationRegistry
    handoffs: Map<string, PendingMobileHistoryHandoff>
  }
): Promise<MobileHistoryContinuationDestination> {
  const { client, session, action, assertCurrentOwner, mutations } = args
  const mutationKey = JSON.stringify([
    session.id,
    action.kind,
    session.executionHostId,
    session.structuredSession?.sessionId ?? session.sessionId,
    session.structuredSession?.workspaceId ?? ''
  ])
  if (action.kind === 'cli' && session.structuredSession) {
    const reply = await agentHistoryHostStatusRead.request(client)
    assertCurrentOwner()
    const host = readMobileAiVaultResumeHost(agentHistoryHostStatusRead.interpret(reply))
    if (!host.capabilities?.includes(SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY)) {
      throw new Error(
        translate(
          'agentHistory.resume.cliUpdateRequired',
          'Update Orca on this host to resume this chat in a new CLI.'
        )
      )
    }
    const created = await sessionTabCreateTerminal.request(
      client,
      {
        worktree: `id:${session.structuredSession.workspaceId}`,
        sourceChatFork: { sessionId: session.structuredSession.sessionId },
        clientMutationId: mutations.claim(mutationKey),
        activate: false,
        select: true,
        navigation: 'caller'
      },
      { timeoutMs: RESUME_RPC_TIMEOUT_MS, beforeSend: assertCurrentOwner }
    )
    assertCurrentOwner()
    const tab = sessionTabCreateTerminal.interpret(created)
    mutations.releaseOnSuccess(mutationKey)
    return {
      worktreeId: session.structuredSession.workspaceId,
      paneKey: terminalTabPaneKey(tab),
      ...(tab.terminal ? { terminal: tab.terminal } : {})
    }
  }
  const { target, platform, settings, host, status } =
    await loadMobileHistoryContinuationTarget(args)
  if (action.kind === 'handoff') {
    if (target.worktreeId !== action.worktreeId) {
      throw new MobileHistoryHandoffWorkspaceChanged(session)
    }
    return handoffMobileHistorySession({
      client,
      session,
      agent: action.agent,
      target,
      capabilities: host.capabilities,
      assertCurrentOwner,
      mutations,
      handoffs: args.handoffs,
      mutationKey
    })
  }
  if (session.agent !== 'codex' && session.agent !== 'claude') {
    throw new Error(
      translate(
        'agentHistory.resume.forkUnsupported',
        'This agent cannot resume in a new CLI conversation.'
      )
    )
  }
  const prepared = await prepareMobileAiVaultSessionResume(client, session)
  assertCurrentOwner()
  const launchKey = JSON.stringify([mutationKey, target.worktreeId])
  const launch = mutations.claimLaunch(launchKey, () =>
    buildMobileAiVaultResumeLaunch({
      session: prepared,
      workspacePlatform: platform,
      hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(status),
      settings,
      fork: true
    })
  )
  const tab = await resumeAiVaultSessionInTerminal(
    client,
    target.worktreeId,
    {
      ...launch,
      hostCapabilities: host.capabilities
    },
    assertCurrentOwner
  )
  mutations.releaseOnSuccess(launchKey)
  return {
    worktreeId: target.worktreeId,
    paneKey: terminalTabPaneKey(tab),
    ...(tab.terminal ? { terminal: tab.terminal } : {})
  }
}
