import {
  createQuestionImportFold,
  type Boundary
} from './structured-agent-session-question-import-fold'
import { createReadStream } from 'node:fs'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import { structuredAgentRuntimeMetadata } from '../../runtime/structured-agent-runtime-metadata'
import { usableJournalHistoryOrigin } from '../agent-session-journal/journal-history-origin'
import { createLegacyIdentityTracker } from '../agent-session-journal/journal-legacy-identity'
import {
  adoptedTranscriptSourceObserver,
  validateAdoptedOpenCodeSource
} from '../agent-session-journal/adopted-transcript-source'
import { createPiTranscriptCollector } from '../agent-session-journal/journal-pi-active-branch'
import { readPiSessionHeader } from '../../pi/rpc-launch-resolution'
import { readOpenCodeNativeChatTranscriptFull } from '../transcript-opencode'
import { nativeChatLineDecoderForAgent } from '../transcript-tail-reader'
import { splitTranscriptStreamLines } from '../transcript-stream-lines'
import { transcriptFallbackId } from '../transcript-fallback-id'
import { readTranscriptFileVersion, transcriptFileVersionChanged } from '../transcript-file-version'
import { toHostReadableTranscriptPath } from '../host-readable-transcript-path'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type QuestionImportJournal = Pick<
  AgentSessionJournal,
  'historyOrigin' | 'questionSourceFacts' | 'itemFence'
>

export function isImportedQuestionRow(
  journal: QuestionImportJournal,
  item: AgentJournalRenderItem
): boolean {
  const identity = parseAgentJournalItemKey(item.itemId)
  return (
    (identity?.provider === 'legacy' || identity?.provider === 'claude') &&
    journal.itemFence(item.itemId) === 0
  )
}

export async function reconstructImport(
  journal: QuestionImportJournal,
  record: AgentSessionConversationView,
  items: readonly AgentJournalRenderItem[],
  workspacePath: (workspaceId: string) => Promise<string>,
  signal: AbortSignal
): Promise<Boundary> {
  const origin = usableJournalHistoryOrigin(journal.historyOrigin())
  const imported = items.filter((item) => isImportedQuestionRow(journal, item))
  const adopted = record.providerHandleChain.find((link) => link.origin === 'adopted')
  if (!origin && !imported.length && !adopted) {
    return { prefix: [], full: new Map() }
  }
  // A proven clear ends the original import even when a floor rewind omitted every imported row.
  if (!imported.length && record.providerContextBoundary) {
    return { prefix: [], full: new Map() }
  }
  const anchorIdentity = parseAgentJournalItemKey(imported[0]?.itemId ?? '')
  const nativeId =
    origin?.providerHandle.kind === 'opaque'
      ? origin.providerHandle.value
      : origin?.providerHandle.kind === 'codex'
        ? origin.providerHandle.threadId
        : origin?.providerHandle.kind === 'claude'
          ? origin.providerHandle.sessionId
          : (adopted?.handle.nativeId ??
            (anchorIdentity?.provider === 'legacy' || anchorIdentity?.provider === 'claude'
              ? anchorIdentity.sessionId
              : undefined))
  const agent =
    adopted?.handle.agent ??
    (anchorIdentity?.provider === 'legacy'
      ? anchorIdentity.agent
      : anchorIdentity?.provider === 'claude'
        ? 'claude'
        : origin?.providerHandle.kind === 'opaque'
          ? origin.providerHandle.agent
          : null)
  const transcriptAgent = agent === 'pi' ? 'omp' : resolveNativeChatTranscriptAgent(agent)
  const importer = agent ? structuredAgentRuntimeMetadata(agent)?.transcriptImport : null
  const decode = agent ? nativeChatLineDecoderForAgent(agent) : null
  if (
    !nativeId ||
    !agent ||
    !transcriptAgent ||
    !importer ||
    !imported.length ||
    (transcriptAgent !== 'opencode' && !decode)
  ) {
    throw new Error('Original question import boundary unavailable')
  }
  const homePath = isLegacyAgentSessionAccountHome(record.accountHome)
    ? await toHostReadableTranscriptPath(record.accountHome.path, {
        wslDistro: record.location.wslDistro ?? undefined,
        signal
      })
    : undefined
  if (isLegacyAgentSessionAccountHome(record.accountHome) && !homePath) {
    throw new Error('Question source account unavailable')
  }
  const accountHome =
    isLegacyAgentSessionAccountHome(record.accountHome) && homePath
      ? { ...record.accountHome, path: homePath }
      : record.accountHome
  const launchEnv = isLegacyAgentSessionAccountHome(accountHome)
    ? { [accountHome.variable]: accountHome.path }
    : {}
  const store = importer.conversationStore({ accountHome, launchEnv })
  const workspaceCwd = await workspacePath(record.location.workspaceId)
  const found = importer.handleNamesTranscript
    ? await toHostReadableTranscriptPath(nativeId, {
        wslDistro: record.location.wslDistro ?? undefined,
        signal
      })
    : store
      ? await importer.findTranscript({
          providerSessionId: nativeId,
          store,
          launchEnv,
          workspaceCwd,
          strictErrors: true
        })
      : null
  const filePath =
    found && store ? await importer.admitTranscriptPath({ store, transcriptPath: found }) : null
  if (!filePath) {
    throw new Error('Original question transcript unavailable')
  }
  signal.throwIfAborted()
  const version = await readTranscriptFileVersion(filePath, signal)
  const providerSessionId = importer.handleNamesTranscript
    ? (await readPiSessionHeader(filePath))?.id
    : nativeId
  if (!providerSessionId) {
    throw new Error('Original question source identity unavailable')
  }
  const sourceIdentity = { providerSessionId, workspaceCwd }
  const source = adoptedTranscriptSourceObserver({
    agent,
    filePath,
    source: sourceIdentity,
    maxSourceBytes: 16 * 1024 * 1024
  })
  const tracker = createLegacyIdentityTracker({ transcriptAgent, agent, sessionId: nativeId })
  const fold = createQuestionImportFold(imported, journal.questionSourceFacts().removed, signal)
  const { accept } = fold
  let offset = 0
  let lineIndex = 0
  if (transcriptAgent === 'opencode') {
    await validateAdoptedOpenCodeSource(filePath, sourceIdentity)
    const read = await readOpenCodeNativeChatTranscriptFull(nativeId, {
      resolveDbPath: async () => filePath
    })
    if ('error' in read) {
      throw new Error(read.error)
    }
    for (const [index, message] of read.messages.entries()) {
      accept(
        message,
        { provider: 'legacy', agent, sessionId: nativeId, recordId: message.id },
        index
      )
    }
  } else {
    const pi =
      agent === 'pi'
        ? createPiTranscriptCollector(
            (message, identity) => ({ message, identity }),
            (line, index) => tracker.identify(line, index)
          )
        : null
    try {
      const stream = createReadStream(filePath, { signal })
      for await (const row of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
        signal.throwIfAborted()
        const line = row.line.endsWith('\r') ? row.line.slice(0, -1) : row.line
        source.observe(line)
        const fallbackId = transcriptFallbackId(filePath, offset)
        offset += row.byteLength
        if (pi) {
          pi.record(line, fallbackId, lineIndex++)
        } else {
          const identity = tracker.identify(line, lineIndex++)
          const message = decode?.(line, fallbackId)
          if (message) {
            accept(message, identity, lineIndex)
          }
          if (fold.boundaryFound()) {
            break
          }
        }
      }
      await pi?.project(({ message, identity }) => accept(message, identity, lineIndex++))
    } finally {
      pi?.close()
    }
  }
  if (transcriptAgent !== 'opencode') {
    await source.validate()
  }
  if (
    !fold.boundaryFound() ||
    transcriptFileVersionChanged(await readTranscriptFileVersion(filePath, signal), version)
  ) {
    throw new Error('Original question source changed during reconstruction')
  }
  return fold.result
}
