import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { agentForksConversations, agentForksThroughChat } from '../../shared/agent-resume-argv'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { pendingAgentSessionRewindFork } from '../../shared/agent-session-rewind'
import type {
  AiVaultPrepareChatForkArgs,
  AiVaultPrepareSessionResumeResult,
  AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { readPiSessionHeader } from '../pi/rpc-launch-resolution'
import { copyStructuredChatRecordConversation } from './structured-chat-conversation-copy'
import { isAiVaultAgent } from './session-list-result-validation'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'

function assertNativeConversationContent(snapshot: AgentJournalSnapshot): void {
  const submissions = new Map(
    snapshot.submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      submission
    ])
  )
  let uncertain = false
  const hasContent = snapshot.items.some(({ itemId, body }) => {
    if (body.kind !== 'message' || (body.role !== 'user' && body.role !== 'assistant')) {
      return false
    }
    const identity = parseAgentJournalItemKey(itemId)
    const submission = submissions.get(itemId)
    if (submission?.dispatchState === 'accepted' || (identity && identity.provider !== 'orca')) {
      return true
    }
    // Write-ahead messages alone prove neither provider content nor failed delivery.
    uncertain ||=
      !submission ||
      submission.dispatchState === 'unknown' ||
      (submission.dispatchState === 'pending' &&
        (!submission.handoverRecorded || submission.handedOverAt !== undefined))
    return false
  })
  if (!hasContent) {
    throw new Error(
      uncertain
        ? 'Could not confirm this conversation was saved. Try again after the agent responds.'
        : 'This chat has no saved conversation to copy.'
    )
  }
}

/** A slow preparation must not launch from a chat that left this workspace. */
export function isStructuredChatCliForkSourceCurrent(
  sessionId: string,
  workspaceId: string
): boolean {
  const record = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
  return Boolean(
    record &&
    record.location.workspaceId === workspaceId &&
    record.location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    record.location.wslDistro === null
  )
}

export async function prepareStructuredChatCliFork(
  args: AiVaultPrepareChatForkArgs,
  prepare: AiVaultSessionResumePreparation
): Promise<AiVaultPrepareSessionResumeResult> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(args.sourceChat.sessionId)
  const registration = record && structuredAgentRuntimeRegistration(record.provider)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (
    !host ||
    !record ||
    !registration ||
    !head ||
    record.location.workspaceId !== args.sourceChat.workspaceId ||
    record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    record.location.wslDistro !== null ||
    // A typed locator has no CODEX_HOME path; forking would silently use the default account.
    (record.provider === 'codex' && !isLegacyAgentSessionAccountHome(record.accountHome)) ||
    !isAiVaultAgent(record.provider) ||
    !agentForksConversations(record.provider)
  ) {
    throw new Error('This chat has no saved conversation available on this host.')
  }
  // A terminal resume can't cut where the rewind did, so it would bring back the undone turns.
  if (
    pendingAgentSessionRewindFork(record.rewind, head.handle.nativeId)?.replacesSessionId ===
    head.handle.nativeId
  ) {
    throw new Error('Send a message after rewinding this chat, then open it in a terminal.')
  }
  const agent = record.provider
  const cwd =
    (await host.deps.resolveWorkspacePath?.(record.location.workspaceId)) || record.launchDirectory
  if (!cwd || !isAbsolute(cwd) || isWslUncPath(cwd)) {
    throw new Error('The chat workspace is unavailable on this host.')
  }
  const providerSessionId = registration.sessionHistory.rowSessionId(head)
  if (!providerSessionId.trim()) {
    throw new Error('This chat has no saved conversation to copy.')
  }
  assertNativeConversationContent(await host.journalSnapshot(record.sessionId))
  if (agentForksThroughChat(agent)) {
    const result = await copyStructuredChatRecordConversation(record, providerSessionId)
    const copy = result.forkedSession
    if (!copy || (agent === 'omp' && !copy.filePath)) {
      throw new Error('The agent did not return a saved conversation copy.')
    }
    return {
      ...result,
      cliForkSource: {
        agent: copy.agent,
        sourceAgent: registration.sessionHistory.rowAgents.at(-1) ?? agent,
        sessionId: copy.sessionId,
        filePath: copy.filePath ?? '',
        codexHome: null,
        cwd,
        executionHostPlatform: process.platform
      }
    }
  }
  const importer = registration.transcriptImport
  if (!importer) {
    throw new Error('This chat cannot be opened in the CLI.')
  }
  const launchEnv = { ...process.env, ...(await host.deps.resolveLaunchEnv?.(agent)) }
  let filePath: string | null
  if (importer.handleNamesTranscript) {
    filePath = head.handle.nativeId
    if (head.handle.transport !== 'jsonl-rpc' || !isAbsolute(filePath) || isWslUncPath(filePath)) {
      throw new Error('The chat has no valid saved session file.')
    }
    const header = await readPiSessionHeader(filePath)
    if (!header || header.id !== providerSessionId) {
      throw new Error('The saved conversation does not match this chat.')
    }
  } else {
    const store = importer.conversationStore({ accountHome: record.accountHome, launchEnv })
    filePath = store
      ? await importer.findTranscript({ providerSessionId, store, launchEnv, workspaceCwd: cwd })
      : null
  }
  if (!filePath || !isAbsolute(filePath) || isWslUncPath(filePath)) {
    throw new Error('This chat has no saved conversation to copy.')
  }
  const saved = await stat(filePath)
  if (!saved.isFile() || saved.size === 0) {
    throw new Error('This chat has no saved conversation to copy.')
  }
  const codexHome =
    agent === 'codex' && isLegacyAgentSessionAccountHome(record.accountHome)
      ? record.accountHome.path
      : null
  const result = await prepare({
    agent,
    sessionId: providerSessionId,
    filePath,
    codexHome,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    fork: true
  })
  const preparedHome = result.useRealCodexHome ? null : (result.substituteCodexHome ?? codexHome)
  if (codexHome && (result.useRealCodexHome || result.substituteCodexHome)) {
    filePath = join(
      preparedHome ?? getSystemCodexHomePath(),
      'sessions',
      relative(join(codexHome, 'sessions'), filePath)
    )
    const preparedFile = await stat(filePath)
    if (!preparedFile.isFile() || preparedFile.size === 0) {
      throw new Error('The prepared conversation is unavailable in the selected account.')
    }
  }
  return {
    ...result,
    cliForkSource: {
      agent,
      sourceAgent: agent,
      sessionId: providerSessionId,
      filePath,
      cwd,
      codexHome: preparedHome,
      executionHostPlatform: process.platform
    }
  }
}
