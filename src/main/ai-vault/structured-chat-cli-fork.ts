import { isNativeConversationMessage } from '../../shared/agent-session-native-content'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { codexDatedRolloutRelativePath } from '../codex/codex-session-resume-home'
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
import { structuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-metadata'
import { readPiSessionHeader } from '../pi/rpc-launch-resolution'
import { copyStructuredChatRecordConversation } from './structured-chat-conversation-copy'
import { isAiVaultAgent } from './session-list-result-validation'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'

export function nativeConversationContent(
  snapshot: Pick<AgentJournalSnapshot, 'items' | 'submissions'>
): 'saved' | 'empty' | 'uncertain' {
  const submissions = new Map(
    snapshot.submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      submission
    ])
  )
  const hasContent = snapshot.items.some(({ itemId, body }) => {
    if (!isNativeConversationMessage(body)) {
      return false
    }
    const identity = parseAgentJournalItemKey(itemId)
    const submission = submissions.get(itemId)
    if (submission?.dispatchState === 'accepted' || (identity && identity.provider !== 'orca')) {
      return true
    }
    return false
  })
  return hasContent
    ? 'saved'
    : snapshot.items.length === 0 && snapshot.submissions.length === 0
      ? 'empty'
      : 'uncertain'
}

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

/** The saved conversation file is missing or unreadable. The message keeps the copy path's words;
 *  a switch reads the reason, so a history it cannot read is never shown as a setup problem. */
export class StructuredChatTranscriptError extends Error {
  constructor(
    message: string,
    readonly reason: 'transcriptNotFound' | 'transcriptUnreadable'
  ) {
    super(message)
  }
}

/** The chat's current conversation on this host, as its CLI would open it; `fork` keeps its copy rules. */
export async function resolveStructuredChatCliSource(
  sourceChat: AiVaultPrepareChatForkArgs['sourceChat'],
  fork: boolean
) {
  const host = getStructuredAgentSessionHost()
  const record =
    host && host.deps.store.selectWritableRecord(sourceChat.sessionId).kind !== 'missing'
      ? host.deps.store.requireWritableRecord(sourceChat.sessionId)
      : undefined
  const metadata = record && structuredAgentRuntimeMetadata(record.provider)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (
    !host ||
    !record ||
    !metadata ||
    !head ||
    record.location.workspaceId !== sourceChat.workspaceId ||
    record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    record.location.wslDistro !== null ||
    // A typed locator has no CODEX_HOME path; forking would silently use the default account.
    (record.provider === 'codex' && !isLegacyAgentSessionAccountHome(record.accountHome)) ||
    !isAiVaultAgent(record.provider) ||
    (fork && !agentForksConversations(record.provider))
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
  const requireCurrent = (): void => {
    const current = host.deps.store.requireWritableRecord(record.sessionId)
    const currentHead = agentSessionProviderHandleChainHead(current.providerHandleChain)
    if (
      current.location.workspaceId !== record.location.workspaceId ||
      current.location.executionHostId !== record.location.executionHostId ||
      current.location.wslDistro !== record.location.wslDistro ||
      currentHead?.linkId !== head.linkId
    ) {
      throw new Error('This chat has no saved conversation available on this host.')
    }
  }
  const agent = record.provider
  const cwd =
    (await host.deps.resolveWorkspacePath?.(record.location.workspaceId)) || record.launchDirectory
  if (!cwd || !isAbsolute(cwd) || isWslUncPath(cwd)) {
    throw new Error('The chat workspace is unavailable on this host.')
  }
  const providerSessionId = metadata.sessionHistory.rowSessionId(head)
  if (!providerSessionId.trim()) {
    throw new StructuredChatTranscriptError(
      'This chat has no saved conversation to copy.',
      'transcriptNotFound'
    )
  }
  assertNativeConversationContent(await host.journalSnapshot(record.sessionId))
  return { host, record, metadata, head, agent, cwd, providerSessionId, requireCurrent }
}

/** Prepares the record's current conversation on its execution host, without a History inventory. */
export async function prepareStructuredChatCliFork(
  args: AiVaultPrepareChatForkArgs,
  prepare: AiVaultSessionResumePreparation
): Promise<AiVaultPrepareSessionResumeResult> {
  const source = await resolveStructuredChatCliSource(args.sourceChat, true)
  const { record, metadata, agent, cwd, providerSessionId } = source
  if (agentForksThroughChat(agent)) {
    source.requireCurrent()
    const result = await copyStructuredChatRecordConversation(record, providerSessionId)
    const copy = result.forkedSession
    if (!copy || (agent === 'omp' && !copy.filePath)) {
      throw new Error('The agent did not return a saved conversation copy.')
    }
    return {
      ...result,
      cliForkSource: {
        agent: copy.agent,
        sourceAgent: metadata.sessionHistory.rowAgents.at(-1) ?? agent,
        sessionId: copy.sessionId,
        filePath: copy.filePath ?? '',
        codexHome: null,
        cwd,
        executionHostPlatform: process.platform
      }
    }
  }
  return prepareStructuredChatCliTranscript(source, prepare, true)
}

/** The transcript a terminal resume (or `fork`) opens, under the account home the host prepared.
 *  A same-id resume refuses a substituted home: another home is another conversation. */
export async function prepareStructuredChatCliTranscript(
  source: Awaited<ReturnType<typeof resolveStructuredChatCliSource>>,
  prepare: AiVaultSessionResumePreparation,
  fork: boolean
): Promise<AiVaultPrepareSessionResumeResult> {
  const { host, record, metadata, head, agent, cwd, providerSessionId } = source
  const importer = metadata.transcriptImport
  if (!importer) {
    throw new Error('This chat cannot be opened in the CLI.')
  }
  const launchEnv = { ...process.env, ...(await host.deps.resolveLaunchEnv?.(agent)) }
  let filePath: string | null
  if (importer.handleNamesTranscript) {
    filePath = head.handle.nativeId
    if (head.handle.transport !== 'jsonl-rpc' || !isAbsolute(filePath) || isWslUncPath(filePath)) {
      throw new StructuredChatTranscriptError(
        'The chat has no valid saved session file.',
        'transcriptUnreadable'
      )
    }
    const header = await readPiSessionHeader(filePath)
    if (!header || header.id !== providerSessionId) {
      throw new StructuredChatTranscriptError(
        'The saved conversation does not match this chat.',
        'transcriptUnreadable'
      )
    }
  } else {
    const store = importer.conversationStore({ accountHome: record.accountHome, launchEnv })
    filePath = store
      ? await importer.findTranscript({ providerSessionId, store, launchEnv, workspaceCwd: cwd })
      : null
  }
  const saved =
    filePath && isAbsolute(filePath) && !isWslUncPath(filePath)
      ? await stat(filePath).catch(() => null)
      : null
  if (!filePath || !saved?.isFile() || saved.size === 0) {
    throw new StructuredChatTranscriptError(
      'This chat has no saved conversation to copy.',
      'transcriptNotFound'
    )
  }
  const codexHome =
    agent === 'codex' && isLegacyAgentSessionAccountHome(record.accountHome)
      ? record.accountHome.path
      : null
  source.requireCurrent()
  const result = await prepare({
    agent,
    sessionId: providerSessionId,
    filePath,
    codexHome,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    ...(fork ? { fork: true } : {})
  })
  const preparedHome = result.useRealCodexHome ? null : (result.substituteCodexHome ?? codexHome)
  if (codexHome && (result.useRealCodexHome || result.substituteCodexHome)) {
    if (!fork) {
      throw new Error('This conversation is saved under a different Codex account here.')
    }
    // Codex canonicalizes CODEX_HOME, so Windows transcripts can carry a \\?\ prefix (#27200).
    const relativePath = codexDatedRolloutRelativePath(join(codexHome, 'sessions'), filePath)
    if (!relativePath) {
      throw new Error('The prepared conversation is unavailable in the selected account.')
    }
    filePath = join(preparedHome ?? getSystemCodexHomePath(), 'sessions', relativePath)
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
