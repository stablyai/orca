import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runKeyedSerializedOperation } from '../../../../shared/concurrency/keyed-serialized-operations'
import { projectSavedChatContextItems } from '../../conversation-context/agent-session-saved-prompt-text'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContinuationContext } from '../../../../shared/agent-session/agent-session-wire'
import { buildAgentSessionHandoffContext } from '../../../../shared/native-chat/transcript/agent-session-handoff-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { formatWorkerTranscriptMessage } from '../../../../shared/native-chat/transcript/worker-transcript-text'
import { toLinuxPath } from '../../../../shared/file-access/wsl-paths'
import {
  agentSessionContextSnapshotRoot,
  writeAgentSessionContextSnapshot
} from '../../conversation-context/agent-session-context-snapshots'
import type { JournalContinuedPayload } from '../../agent-session-journal/journal-reads'
import {
  ContinuedTranscriptMarkers,
  continuedFileText
} from '../../conversation-context/agent-session-continued-transcript'
import { ensureOwnedTempStagingRoot } from '../../../filesystem/owned-temp-staging-root'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

export function continuationContextReader(
  deps: StructuredAgentSessionHostDeps,
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
) {
  return async (input: {
    sessionId: string
    workspaceId: string
    expectedCursor: AgentJournalCursor
  }): Promise<AgentSessionContinuationContext> => {
    const sourceConversation = () => {
      const record = deps.store.getConversation(input.sessionId)
      return record?.location.workspaceId === input.workspaceId &&
        record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? record
        : null
    }
    if (!sourceConversation()) {
      return { status: 'superseded' }
    }
    const session = await conversation(input.sessionId)
    const context = await session.journal.reads.continuationContext()
    const record = sourceConversation()
    if (
      !record ||
      context.cursor.epoch !== input.expectedCursor.epoch ||
      context.cursor.sequence < input.expectedCursor.sequence
    ) {
      return { status: 'superseded' }
    }
    // A large tool output or patch arrives as an excerpt; its whole text streams into the file.
    const markers = new ContinuedTranscriptMarkers()
    const items = [...context.items]
    context.continued.forEach((part, index) => {
      items[part.index] = markers.mark(items[part.index], index)
    })
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      context.submissions,
      projectSavedChatContextItems
    )
    const continued = context.continued.length > 0
    const capturedText = buildAgentSessionHandoffContext(
      continued ? markers.excerpts(messages) : messages
    )
    const formatted = messages.map(formatWorkerTranscriptMessage)
    const text = continued ? '' : formatted.join('\n\n')
    if (!continued && !text.trim()) {
      return { status: 'current', capturedText: '' }
    }
    // Spills not yet streamed and removed.
    const spills = new Set<string>()
    let prepared: Promise<void> | undefined
    const snapshotRoot = agentSessionContextSnapshotRoot(deps.journalDatabase.stateDirectory)
    // Apart from published snapshots, so the crash sweep visits only spills.
    const spillRoot = join(snapshotRoot, 'spills')
    // One extraction per text, written by the reader to a private file main then streams.
    const spill = async (part: JournalContinuedPayload, trimEnd: boolean) => {
      // Checked and swept once per export, before its first spill.
      prepared ??= (async () => {
        if (
          !(await ensureOwnedTempStagingRoot(snapshotRoot)) ||
          !(await ensureOwnedTempStagingRoot(spillRoot))
        ) {
          throw new Error('Chat context snapshot folder is not private')
        }
        await removeStaleSpills(spillRoot)
      })()
      await prepared
      const path = join(spillRoot, `${randomUUID()}.spill`)
      spills.add(path)
      activeSpills.add(path)
      const { itemId, revision, field } = part
      // One extraction at a time across exports: each can hold a whole stored text in the reader.
      const bytes = await runKeyedSerializedOperation(spillQueue, 'spill', () =>
        session.journal.reads.continuationSpill({ itemId, revision, field, path })
      )
      if (bytes === null) {
        throw new ContinuedPayloadSuperseded()
      }
      return continuedFileText(path, trimEnd, async () => {
        // A failed removal leaves the file to the export's cleanup, then to a later sweep.
        await rm(path, { force: true })
        spills.delete(path)
        activeSpills.delete(path)
      })
    }
    let path: string
    try {
      // Both outputs describe this stopping point, even if the conversation changes during the write.
      path = await writeAgentSessionContextSnapshot(
        deps.journalDatabase.stateDirectory,
        input.sessionId,
        continued
          ? markers.transcript(formatted, (index, trimEnd) =>
              spill(context.continued[index], trimEnd)
            )
          : text
      )
    } catch (error) {
      if (error instanceof ContinuedPayloadSuperseded) {
        return { status: 'superseded' }
      }
      throw error
    } finally {
      try {
        await Promise.all([...spills].map((spilled) => rm(spilled, { force: true })))
      } finally {
        // Released either way, so a file whose removal failed can be swept once stale.
        for (const spilled of spills) {
          activeSpills.delete(spilled)
        }
      }
    }
    return {
      status: 'current',
      capturedText,
      transcriptPath: record.location.wslDistro ? toLinuxPath(path) : path
    }
  }
}

class ContinuedPayloadSuperseded extends Error {}

const spillQueue = new Map<string, Promise<void>>()
// Spills of exports still running, however long one sleeps; the sweep leaves them.
const activeSpills = new Set<string>()
// An unowned spill this old was left by a crash.
const STALE_SPILL_MS = 60 * 60 * 1000

async function removeStaleSpills(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [])
  for (const name of names.filter((entry) => entry.endsWith('.spill'))) {
    const path = join(root, name)
    if (activeSpills.has(path)) {
      continue
    }
    const modified = await stat(path).then(
      (info) => info.mtimeMs,
      () => Date.now()
    )
    if (Date.now() - modified > STALE_SPILL_MS) {
      await rm(path, { force: true })
    }
  }
}
