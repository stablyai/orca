import { join } from 'node:path'
import type { StructuredAgentSessionTurnContext } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botMemoryChange, isEmptyBotMemoryChange } from '../../shared/bot-memory-lines'
import type { BotTurnContextState as Given, BotFirstRun } from './bot-turn-context-contract'
import type { BotHomeFilesystem } from './bot-home'
import { type BotMemoryRecord, tagBotMemoryFile } from './bot-memory-record'
import {
  type BotMemoryTopics,
  botMemoryTopicsKey,
  botMemoryKnown,
  botTurnFingerprint as fingerprint
} from './bot-turn-memory-update'
import {
  besideTurn,
  type BotChatJournal,
  ownerOpened,
  turnOpenedAt,
  turnRows
} from './bot-turn-rows'
import { writesHomeFile } from './bot-turn-source'
import { readdGuard } from './bot-memory-readd-guard'

import { writeBotTurnMemoryReceipt } from './bot-turn-memory-receipt'

export { BOT_MEMORY_UPDATED_NOTE } from '../../shared/bots/bot-memory-updated-note'

export function createBotTurnCompletion({
  fs,
  record,
  given,
  update,
  firstRun,
  chats,
  readTopics,
  capture
}: {
  fs: Pick<BotHomeFilesystem, 'readText' | 'replaceText' | 'writeText'>
  record: Pick<BotMemoryRecord, 'after' | 'version' | 'changedBesides' | 'noted' | 'history'>
  given: ReadonlyMap<string, Given>
  update: (sessionId: string, fields: Partial<Given>) => void
  firstRun: BotFirstRun
  chats: BotChatJournal
  readTopics: (folder: string) => Promise<BotMemoryTopics>
  capture: (sessionId: string) => () => boolean
}): NonNullable<StructuredAgentSessionTurnContext['turnEnded']> {
  return (sessionId, turnId, readItems, writeNote, ended) => {
    const entry = given.get(sessionId)
    const currentLaunch = capture(sessionId)
    const current = () => currentLaunch() && ended?.isCurrent?.() !== false
    if (!entry || !current()) {
      return
    }
    const { memoryAtStart, topicsAtStart, receiptAtStart } = entry
    update(sessionId, { memoryAtStart: null, topicsAtStart: null, receiptAtStart: null })
    return record
      .after(
        entry.botId,
        async (recorded) => {
          if (!current()) {
            return undefined
          }
          const soul = await fs.readText(join(entry.folder, 'SOUL.md'))
          if (!current()) {
            return undefined
          }
          const since = given.get(sessionId)?.scannedThrough ?? entry.scannedThrough
          const journal = await readItems(since)
          if (!current()) {
            return undefined
          }
          const { items } = journal
          const turn = since === null ? items : items.filter((item) => item.sequence > since)
          // That turn's own opener: rows written since, such as a next turn's, are not this end's.
          if (ownerOpened(journal, turnId)) {
            firstRun.ownerTurnEnded(entry.botId, sessionId)
          }
          // The other conversations, read only when this end can take a fact into the shared
          // baseline: their outside turns may have written it.
          const own = { sessionId, scannedThrough: since, turn }
          const { label, alone } = besideTurn(own, turnOpenedAt(items, turnId), chats, () =>
            [...given]
              .filter(([id, other]) => id !== sessionId && other.botId === entry.botId)
              .map(([id, other]) => ({ sessionId: id, scannedThrough: other.scannedThrough }))
          )
          const edited = turnRows(journal, turnId, turn).some(
            ({ body }) => body.kind === 'tool-call' || body.kind === 'diff'
          )
          const topics = edited ? await readTopics(entry.folder) : new Map()
          if (!current()) {
            return undefined
          }
          // memory/ by the MEMORY.md rule, with no record: the turn's own when it ran alone, from
          // the files the agent had at its start.
          const hadTopics = given.get(sessionId)?.topics
          if (edited && hadTopics && botMemoryTopicsKey(hadTopics) === topicsAtStart) {
            if (botMemoryTopicsKey(topics) !== topicsAtStart && (await alone()) && current()) {
              update(sessionId, { topics })
            }
          }
          // Not known yet: everything in the file is new.
          const before = recorded ?? ''
          const keepOut = await readdGuard(fs, entry, record, turn)
          if (!current()) {
            return undefined
          }
          const tagged = await tagBotMemoryFile(fs, entry.folder, before, label, keepOut, current)
          await writeBotTurnMemoryReceipt(
            {
              botId: entry.botId,
              sessionId,
              turnId,
              items,
              before: receiptAtStart,
              memory: tagged?.text,
              topics,
              edited
            },
            record,
            alone,
            writeNote,
            current
          )
          if (!tagged || !current()) {
            return undefined
          }
          // Before the record knew the file, nothing it holds is this turn's; an empty change
          // writes no history row, so its source is never read.
          const change = recorded === null ? null : botMemoryChange(recorded, tagged.text)
          const by = !change || isEmptyBotMemoryChange(change) ? null : await label()
          // Read through the head: an empty window (a refused send's end names no turn row) must
          // not leave the mark at 0, which would make the next end's window the whole chat.
          const scanned =
            journal.head ?? items.reduce((max, item) => Math.max(max, item.sequence), 0)
          const botWrote = (name: 'SOUL.md' | 'MEMORY.md'): boolean =>
            since !== null && turn.some((item) => writesHomeFile(item.body, name))
          const memory = fingerprint(tagged.text)
          // Only a file the turn changed has anything to take; an unchanged one is already had.
          const changed =
            memoryAtStart !== null &&
            memory !== memoryAtStart &&
            // Not when facts were put back or kept out: its next turn is sent them.
            isEmptyBotMemoryChange(tagged.kept) &&
            edited
          const ranAlone = changed && (await alone())
          if (!current()) {
            return undefined
          }
          const now = given.get(sessionId) ?? entry
          const ownMemory =
            ranAlone &&
            now.memory !== null &&
            // The file at the turn's start was what the agent had.
            memoryAtStart === now.memory &&
            // This chat's own record changes (its Forget, its turn ends) are not another writer's.
            !record.changedBesides(entry.botId, sessionId, now.memoryRecord)
          update(sessionId, {
            scannedThrough: scanned,
            ...(botWrote('SOUL.md') ? { soul: fingerprint(soul) } : {}),
            ...(ownMemory
              ? {
                  memory,
                  memoryText: botMemoryKnown(now.memoryText, tagged.text),
                  memoryRecord: record.version(entry.botId)
                }
              : {})
          })
          if (change) {
            record.noted(entry.botId, { kind: 'chat', sessionId, source: by }, change)
          }
          record.noted(entry.botId, { kind: 'kept', sessionId }, tagged.kept)
          return tagged.text
        },
        sessionId,
        current
      )
      .catch(() => {})
  }
}
