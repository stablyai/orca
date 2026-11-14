import { randomUUID } from 'node:crypto'
import type {
  AiVaultExportChatForkRequest,
  AiVaultExportChatForkResult
} from '../../../shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { CHAT_FORK_TRANSFER_CHUNK_BYTES } from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import { sliceAtCodeUnitLimit } from '../../../shared/surrogate-safe-text-slice'
import { resolveClaudeForkSource } from '../../claude/transcripts/claude-conversation-copy'
import type { ClaudeForkCheckpoint } from '../../claude/transcripts/claude-conversation-fork-boundary'
import { materializeClaudeConversationTranscript } from '../../claude/transcripts/claude-rewind-transcript'
import { admitStructuredAgentSessionFork } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-fork-source'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { findClaudeTerminalTranscript } from '../terminal-chat-fork-cut'
import type { ChatForkTransferStore } from './chat-fork-transfer-store'
import { ChatForkTransferError } from './chat-fork-transfer-ownership'

const EXPORT_COPY_TIMEOUT_MS = 120_000

type ExportSource = {
  sourcePath: string
  sourceSessionId: string
  cut: { throughEntryId: string } | { checkpoint: ClaudeForkCheckpoint }
  title?: string
}

/** Cuts a Claude chat on this host into a staged transcript another host can fetch. */
export async function exportChatFork(input: {
  request: AiVaultExportChatForkRequest
  owner: string
  store: ChatForkTransferStore
  ensureStructuredHost: () => Promise<unknown>
}): Promise<AiVaultExportChatForkResult> {
  const source =
    'terminal' in input.request
      ? await terminalSource(input.request.terminal)
      : await structuredSource(input.request.structured, input.ensureStructuredHost)
  let sourceSessionId = ''
  const staged = await input.store.createExport(input.owner, async (directory) => {
    const copy = await materializeClaudeConversationTranscript({
      sourcePath: source.sourcePath,
      sourceSessionId: source.sourceSessionId,
      ...source.cut,
      destinationDirectory: directory,
      signal: AbortSignal.timeout(EXPORT_COPY_TIMEOUT_MS)
    })
    if (!copy) {
      throw new ChatForkTransferError('chat_fork_source_unavailable')
    }
    sourceSessionId = copy.sessionId
    return copy
  })
  return {
    ...staged,
    agent: 'claude',
    sourceSessionId,
    chunkBytes: CHAT_FORK_TRANSFER_CHUNK_BYTES,
    ...(source.title ? { title: source.title } : {})
  }
}

async function terminalSource(request: {
  sessionId: string
  throughEntryId: string
}): Promise<ExportSource> {
  // Looked up by id among this host's own Claude homes; a caller never names a file.
  const sourcePath = await findClaudeTerminalTranscript(request.sessionId)
  if (!sourcePath) {
    throw new ChatForkTransferError('chat_fork_source_unavailable')
  }
  return {
    sourcePath,
    sourceSessionId: request.sessionId,
    cut: { throughEntryId: request.throughEntryId }
  }
}

async function structuredSource(
  request: { sessionId: string; workspaceId: string; throughItemId: string },
  ensureStructuredHost: () => Promise<unknown>
): Promise<ExportSource> {
  await ensureStructuredHost()
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(request.sessionId)
  if (
    !host ||
    !record ||
    record.provider !== 'claude' ||
    record.location.workspaceId !== request.workspaceId ||
    record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    record.location.wslDistro !== null
  ) {
    throw new ChatForkTransferError('chat_fork_source_unavailable')
  }
  // Same admission as an in-host fork, so turn, rewind and clear guards apply unchanged.
  const admitted = await admitStructuredAgentSessionFork({
    host,
    sessionId: request.sessionId,
    throughItemId: request.throughItemId,
    agent: 'claude',
    location: record.location,
    envelope: {
      sessionId: randomUUID(),
      clientOperationId: randomUUID(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    }
  })
  const found = await resolveClaudeForkSource({
    checkpoint: admitted.selected.checkpoint,
    accountHome: admitted.record.accountHome,
    signal: AbortSignal.timeout(EXPORT_COPY_TIMEOUT_MS)
  })
  if (!found) {
    throw new ChatForkTransferError('chat_fork_source_unavailable')
  }
  const title = admitted.record.conversationName?.trim()
  return {
    sourcePath: found.sourcePath,
    sourceSessionId: found.sourceSessionId,
    cut: { checkpoint: found.checkpoint },
    ...(title ? { title: sliceAtCodeUnitLimit(title, 200) } : {})
  }
}
