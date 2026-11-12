import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { asRecord } from '../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../ai-vault/parsing/session-json-object'
import { createLegacyIdentityTracker } from '../native-chat/agent-session-journal/history-import/journal-legacy-identity'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { decodeCodexTranscriptLine } from '../native-chat/transcript-line-decoders-codex'

type Root = { id?: string; terminal: boolean; prompt: boolean }

/** Use the importer's physical lineage and identity accounting, including discarded window rows. */
export async function codexForkHistory(input: {
  path: string
  roots: string[]
  selectedItemId: string
  turnId?: string
  sessionId: string
  signal?: AbortSignal
  inheritedOnly?: boolean
}) {
  const identity = parseAgentJournalItemKey(input.selectedItemId)
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: 'codex',
    agent: 'codex',
    sessionId: input.sessionId
  })
  const roots: Root[] = []
  let selected: Root | undefined
  let lineIndex = 0
  let referenceBacked = false
  await readCodexLocalHistory({
    filePath: input.path,
    roots: input.roots,
    visitRecord: ({ record, selected }) => {
      if (selected && record?.type === 'session_meta') {
        referenceBacked = asRecord(record.payload)?.history_base != null
      }
    },
    visit: (line, fallbackId, selectedSegment, recordId) => {
      if (input.inheritedOnly && referenceBacked && selectedSegment) {
        return
      }
      input.signal?.throwIfAborted()
      const tracked = tracker.identify(line, lineIndex++)
      const raw = parseJsonObject(line)
      const payload = asRecord(raw?.payload)
      if (
        raw?.type === 'event_msg' &&
        payload?.type === 'thread_rolled_back' &&
        typeof payload.num_turns === 'number'
      ) {
        roots.splice(Math.max(0, roots.length - payload.num_turns))
        return
      }
      if (raw?.type === 'event_msg' && payload?.type === 'task_started') {
        roots.push({
          id: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
          terminal: false,
          prompt: false
        })
      }
      const message = decodeCodexTranscriptLine(line, fallbackId, { historyImport: true })
      if (message?.role === 'user') {
        const previous = roots.at(-1)
        if (!previous || (previous.prompt && (!previous.id || previous.terminal))) {
          roots.push({ terminal: false, prompt: true })
        } else {
          previous.prompt = true
        }
      }
      const root = roots.at(-1)
      if (
        root &&
        raw?.type === 'event_msg' &&
        (payload?.type === 'task_complete' || payload?.type === 'turn_aborted') &&
        (!payload.turn_id || payload.turn_id === root.id)
      ) {
        root.terminal = true
      }
      const importedMatch =
        identity?.provider === 'legacy' &&
        identity.recordId ===
          (recordId ?? (tracked.provider === 'legacy' ? tracked.recordId : undefined))
      if (
        root &&
        ((importedMatch && message?.role === 'assistant') ||
          (input.turnId && root.id === input.turnId))
      ) {
        if (selected && selected !== root) {
          throw new AgentConversationCopyError('Codex could not verify the copied chat.')
        }
        selected = root
      }
    }
  })
  const index = selected ? roots.indexOf(selected) : -1
  if (index < 0) {
    throw new AgentConversationCopyError('Codex could not verify the copied chat.')
  }
  return { roots, index, selected: roots[index] }
}
