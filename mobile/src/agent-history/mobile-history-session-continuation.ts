import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { buildAgentSessionContinuationPrompt } from '../../../src/shared/agent-session/context/agent-session-continuation'
import { prepareAiVaultSessionContinuation } from '../../../src/shared/agent-session/context/ai-vault-session-continuation'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { translate } from '../i18n/mobile-i18n'
import { sessionTabCreateTerminal } from '../session/tabs/mobile-session-tab-write-operations'
import { launchAgentInExistingWorkspace } from '../session/agent-launch/mobile-existing-agent-launch'
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
import { mobileHistoryTerminalPane } from './mobile-history-session-destination'

export type MobileHistorySessionAction =
  | { kind: 'resume' }
  | { kind: 'cli' }
  | { kind: 'handoff'; agent: TuiAgent }

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
  }
): Promise<{ worktreeId: string; paneKey?: string }> {
  const { client, session, action, assertCurrentOwner, mutations } = args
  const mutationKey = `${session.id}:${action.kind}`
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
      paneKey: mobileHistoryTerminalPane(tab)
    }
  }
  const { target, platform, settings, host, status } =
    await loadMobileHistoryContinuationTarget(args)
  if (action.kind === 'handoff') {
    // shortcut: database-backed rows use their preview; add host snapshots when mobile exposes that RPC.
    const request = prepareAiVaultSessionContinuation({
      session,
      targetWorktreeId: target.worktreeId,
      targetWorkspacePath: target.workspacePath ?? session.cwd ?? ''
    })
    const prompt = buildAgentSessionContinuationPrompt(request.source, 'focused')
    if (!prompt) {
      throw new Error(
        translate(
          'agentHistory.handoff.noContext',
          'No conversation context is available to hand off.'
        )
      )
    }
    assertCurrentOwner()
    const launched = await launchAgentInExistingWorkspace({
      client,
      hostCapabilities: host.capabilities,
      worktreeId: target.worktreeId,
      agent: action.agent,
      prompt: { text: prompt, delivery: 'submit' },
      mintOperationId: () => mutations.claim(`${mutationKey}:${action.agent}`)
    })
    assertCurrentOwner()
    if (launched.kind !== 'launched') {
      throw new Error(
        'message' in launched
          ? launched.message
          : translate(
              'agentHistory.handoff.updateRequired',
              'Update Orca on this host to hand off a session.'
            )
      )
    }
    if (launched.promptDelivered !== true || launched.result.prompt?.outcome === 'unconfirmed') {
      throw new Error(
        translate(
          'agentHistory.handoff.unconfirmed',
          'The agent started, but context delivery was not confirmed. Check the new session before retrying.'
        )
      )
    }
    mutations.releaseOnSuccess(`${mutationKey}:${action.agent}`)
    const outcome = launched.result.outcome
    return {
      worktreeId: launched.result.worktreeId,
      paneKey:
        outcome.kind === 'structured'
          ? structuredAgentSessionPaneKey(
              outcome.tabId ?? structuredAgentSessionTabId(outcome.sessionId),
              outcome.sessionId
            )
          : outcome.paneKey
    }
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
  const launch = buildMobileAiVaultResumeLaunch({
    session: prepared,
    workspacePlatform: platform,
    hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(status),
    settings,
    fork: true
  })
  const tab = await resumeAiVaultSessionInTerminal(
    client,
    target.worktreeId,
    {
      ...launch,
      hostCapabilities: host.capabilities,
      clientMutationId: mutations.claim(mutationKey)
    },
    assertCurrentOwner
  )
  mutations.releaseOnSuccess(mutationKey)
  return { worktreeId: target.worktreeId, paneKey: mobileHistoryTerminalPane(tab) }
}
