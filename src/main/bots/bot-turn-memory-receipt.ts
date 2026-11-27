import type {
  AgentJournalPlainStatusItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotMemoryRecord } from './bot-memory-record'
import {
  botMemoryChange,
  onlyBotMemoryFactsChanged,
  parseBotMemoryFacts
} from '../../shared/bot-memory-lines'
import {
  botMemoryUpdatedNoteBody,
  type BotMemoryUpdatedNote
} from '../../shared/bots/bot-memory-updated-note'
import type { BotMemoryTopics } from './bot-turn-memory-update'

export type BotTurnMemorySnapshot = {
  memory: string | null
  topics: BotMemoryTopics
  version: number
}

/** A net result, using the same fact comparison as history; never pair unrelated add/remove rows. */
export function botTurnMemoryReceipt(
  botId: string,
  before: BotTurnMemorySnapshot,
  memory: string | null,
  topics: BotMemoryTopics
): ReturnType<typeof botMemoryUpdatedNoteBody> | null {
  const change = botMemoryChange(before.memory ?? '', memory ?? '')
  const words = (lines: typeof change.added): string[] =>
    lines.map(({ line }) => parseBotMemoryFacts(line)[0]?.text ?? line)
  const changedTopics = [...new Set([...before.topics.keys(), ...topics.keys()])]
    .filter((name) => before.topics.get(name)?.fingerprint !== topics.get(name)?.fingerprint)
    .map((name) => `memory/${name}`)
  const note: BotMemoryUpdatedNote = {
    botId,
    added: words(change.added),
    removed: words(change.removed),
    topics: changedTopics,
    otherChanges: onlyBotMemoryFactsChanged(before.memory ?? '', memory ?? '') ? 0 : 1
  }
  return note.added.length + note.removed.length + note.topics.length + note.otherChanges > 0
    ? botMemoryUpdatedNoteBody(note)
    : null
}

export async function writeBotTurnMemoryReceipt(
  turn: {
    botId: string
    sessionId: string
    turnId: string
    items: readonly AgentJournalRenderItem[]
    before: BotTurnMemorySnapshot | null
    memory: string | undefined
    topics: BotMemoryTopics
    edited: boolean
  },
  record: Pick<BotMemoryRecord, 'changedBesides'>,
  alone: () => Promise<boolean>,
  writeNote: ((id: string, body: AgentJournalPlainStatusItem) => Promise<void>) | undefined
): Promise<void> {
  if (
    !writeNote ||
    !turn.before ||
    !turn.edited ||
    record.changedBesides(turn.botId, turn.sessionId, turn.before.version) ||
    !(await alone())
  ) {
    return
  }
  const receipt = botTurnMemoryReceipt(
    turn.botId,
    turn.before,
    turn.memory ?? turn.before.memory,
    turn.topics
  )
  if (receipt) {
    await writeNote?.(
      `bot-memory-updated:${turn.turnId}:${turn.items.at(-1)?.sequence ?? 0}`,
      receipt
    )?.catch(() => {})
  }
}
