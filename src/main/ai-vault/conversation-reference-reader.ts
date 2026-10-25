import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import type {
  ConversationReferenceCreate,
  ConversationReferenceRead,
  ConversationReferencePage,
  ConversationReference,
  ConversationSource
} from '../../shared/conversation-reference'
import { parseConversationReferenceUri } from '../../shared/conversation-reference'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectConversationReferencePage } from './conversation-reference-page'
import {
  saveConversationReference,
  loadConversationReference
} from './conversation-reference-store'
import { readConversationTranscriptInService } from './session-scanner-service-spawn'
import { localAiVaultScanRoots, findCachedAiVaultSession } from './cached-session-list'
import { isWslUncPath } from '../../shared/wsl-paths'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'

type ListSessions = () => Promise<AiVaultListResult>

async function resolveTranscript(
  source: Extract<ConversationSource, { kind: 'transcript' }>,
  list: ListSessions
): Promise<AiVaultSession> {
  const cached = findCachedAiVaultSession(source)
  if (cached) {
    return cached
  }
  const result = await list()
  const matches = result.sessions.filter(
    (session) =>
      session.agent === source.agent &&
      session.sessionId === source.sessionId &&
      (!source.filePath || session.filePath === source.filePath) &&
      (source.codexHome === undefined || session.codexHome === source.codexHome)
  )
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? 'More than one saved conversation matches this reference. Drag the intended history entry again.'
        : 'The source conversation is unavailable. Refresh Session History and attach it again.'
    )
  }
  return matches[0]!
}

export async function createLocalConversationReference(
  request: ConversationReferenceCreate,
  list: ListSessions
): Promise<ConversationReference> {
  const source = request.source
  if (source.kind === 'structured') {
    const record = getStructuredAgentSessionHost()?.deps.store.getRecord(source.sessionId)
    if (!record || record.location.workspaceId !== source.workspaceId) {
      throw new Error('The source chat is unavailable.')
    }
    return saveConversationReference(request, record.provider)
  }
  const session = await resolveTranscript(source, list)
  return saveConversationReference(
    {
      ...request,
      source: { ...source, filePath: session.filePath, codexHome: session.codexHome }
    },
    session.agent
  )
}

function feedJournal(
  snapshot: AgentJournalSnapshot,
  push: ReturnType<typeof collectConversationReferencePage>['push']
): void {
  const truncated = new Set(
    snapshot.items
      .filter(({ body }) =>
        body.kind === 'tool-call'
          ? body.output?.truncated
          : body.kind === 'diff' && body.patch.truncated
      )
      .map((item) => item.itemId)
  )
  for (const message of projectStructuredAgentSessionMessages(
    snapshot.items,
    [],
    snapshot.submissions
  )) {
    if (
      message.unsent ||
      (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')
    ) {
      continue
    }
    const text = message.blocks
      .flatMap((block) => {
        if (block.type === 'text') {
          return [block.text]
        }
        if (block.type === 'tool-call') {
          return [`${block.name}\n${JSON.stringify(block.input) ?? ''}`]
        }
        if (block.type === 'tool-result') {
          return [block.output]
        }
        if (block.type === 'image-ref') {
          return [`[Image: ${block.path ?? block.url ?? block.alt ?? ''}]`]
        }
        return []
      })
      .join('\n')
    if (text) {
      push({
        role: message.role,
        text,
        timestamp: message.timestamp === null ? null : new Date(message.timestamp).toISOString(),
        ...(truncated.has(message.id) ? { textTruncated: true } : {})
      })
    }
  }
}

export async function readLocalConversationReference(
  request: ConversationReferenceRead,
  signal?: AbortSignal,
  ensureHost?: () => Promise<void>
): Promise<ConversationReferencePage | null> {
  const identity = parseConversationReferenceUri(request.reference)
  if (!identity) {
    throw new Error('Invalid conversation reference.')
  }
  const stored = await loadConversationReference(identity.id)
  if (!stored) {
    return null
  }
  const reference = { uri: request.reference, title: stored.title, agent: stored.agent }
  if (stored.source.kind === 'structured') {
    await ensureHost?.()
    const host = getStructuredAgentSessionHost()
    const record = host?.deps.store.getRecord(stored.source.sessionId)
    if (!host || !record || record.location.workspaceId !== stored.source.workspaceId) {
      throw new Error('The source chat is unavailable.')
    }
    const snapshot = await host.journalSnapshot(record.sessionId)
    const version = `${snapshot.cursor.epoch}:${snapshot.cursor.sequence}`
    const page = collectConversationReferencePage(identity.id, version, request)
    feedJournal(snapshot, page.push)
    return { reference, ...page.finish() }
  }
  const source = stored.source
  if (!source.filePath) {
    throw new Error('The reference has no saved source location. Attach it again.')
  }
  const roots = isWslUncPath(source.filePath) ? await localAiVaultScanRoots() : null
  return {
    reference,
    ...(await readConversationTranscriptInService(
      {
        id: identity.id,
        source,
        request,
        ...(roots ? { wslOpenCodeReaders: roots.wslOpenCodeReaders } : {})
      },
      signal
    ))
  }
}
