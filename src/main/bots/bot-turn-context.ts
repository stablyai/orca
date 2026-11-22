// A running bot chat hears of outside memory changes and receipts its own committed writes.
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botMemoryChange, isEmptyBotMemoryChange } from '../../shared/bot-memory-lines'
import {
  type BotMemoryTopics,
  botMemoryTopicsKey,
  botMemoryTopicsUpdateText,
  botMemoryUpdateText,
  botMemoryKnown,
  botTurnFingerprint as fingerprint,
  readBotMemoryTopics
} from './bot-turn-memory-update'
import type { BotRecentChatsSection } from './bot-recent-chats'
import {
  type BotTurnLinkedSkills,
  linkedProjectsKey,
  linkedSkillsUpdate as skillsUpdate,
  NO_BOT_TURN_LINKED_SKILLS,
  relinkedSkills
} from './bot-turn-linked-skills'
import type { BotTurnContext, BotFirstRun } from './bot-turn-context-types'
import type { StructuredAgentSessionTurnContextPlan as TurnPlan } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botLaunchedInstructions, withBotRulesUpdate } from './bot-turn-rules-update'
import { type BotTurnGiven as Given, launchedBotTurnGiven } from './bot-turn-given'
import { writesHomeFile } from './bot-turn-source'
import {
  besideTurn,
  NO_BOT_CHAT_JOURNAL,
  ownerOpened,
  turnOpenedAt,
  turnRows
} from './bot-turn-rows'
import { botContextNoteBody, type BotContextChange } from '../../shared/bots/bot-context-note'
import { readBotHomeFiles } from './bot-preamble'
import type { BotHomeFilesystem } from './bot-home'
import { type BotMemoryRecord, createBotMemoryRecord, tagBotMemoryFile } from './bot-memory-record'
import { readdGuard } from './bot-memory-readd-guard'

import { writeBotTurnMemoryReceipt } from './bot-turn-memory-receipt'

export { BOT_MEMORY_UPDATED_NOTE } from '../../shared/bots/bot-memory-updated-note'

// Workflow only: how the bot should weigh the update, never how it should sound.
const COPY = {
  soul: "[Your SOUL.md was updated; this replaces your earlier standing instructions. They rank below the user's current request.]"
}

export type { BotTurnContext, BotFirstRun } from './bot-turn-context-types'

type Held = string | null | undefined

const NO_FIRST_RUN: BotFirstRun = { rules: () => null, ownerTurnEnded: () => {} }

export function createBotTurnContext(
  fs: Pick<BotHomeFilesystem, 'readText' | 'replaceText' | 'writeText'> &
    Partial<Pick<BotHomeFilesystem, 'listNames' | 'statFile' | 'makeDirectory'>>,
  /** A new bot's first run in a session: its rules ride each turn there, until the owner's turn ends. */
  firstRun: BotFirstRun = NO_FIRST_RUN,
  /** Any conversation's rows, so a turn end hears of outside turns still running beside it. */
  chats = NO_BOT_CHAT_JOURNAL,
  /** Which worker a turn's conversation handed its code work to. */
  workNote: (
    sessionId: string,
    message: AgentJournalMessageItem
  ) => Promise<string | null> = async () => null,
  /** Each bot's MEMORY.md as Orca last recorded it, which Forget also updates. */
  record: Pick<
    BotMemoryRecord,
    'started' | 'version' | 'changedBesides' | 'after' | 'noted' | 'history'
  > = createBotMemoryRecord(fs),
  linkedSkills: BotTurnLinkedSkills = NO_BOT_TURN_LINKED_SKILLS,
  /** What the bot's other chats did lately, as this turn's message may hear of it. */
  recentChats: (
    botId: string,
    sessionId: string,
    message: AgentJournalMessageItem
  ) => Promise<BotRecentChatsSection | null> = async () => null,
  /** Every fifth turn of an owner chat, whoever started it: questions the owner left unanswered. */
  unansweredQuestionNote: (sessionId: string) => Promise<string | null> = async () => null,
  /** Current metadata, so a rename also reaches an already-running chat. */
  currentBotName: (botId: string) => string | null = () => null
): BotTurnContext {
  const readTopics = (folder: string): Promise<BotMemoryTopics> => readBotMemoryTopics(fs, folder)
  // Per session, in memory: after a host restart, `launched` says what the relaunched agent read.
  const given = new Map<string, Given>()
  const update = (sessionId: string, fields: Partial<Omit<Given, 'botId' | 'folder'>>): void => {
    const entry = given.get(sessionId)
    if (entry) {
      given.set(sessionId, { ...entry, ...fields })
    }
  }
  /** A project linked or unlinked since launch makes the list the agent should have now. */
  const relinked = async (sessionId: string, entry: Given): Promise<Given> => {
    const next = await relinkedSkills(linkedSkills, sessionId, entry)
    if (next) {
      update(sessionId, next)
    }
    return given.get(sessionId) ?? entry
  }
  /** Orca's Tools and Rules, under the bot's current name, go first, where they outrank memory. */
  const withOrcaRules = (sessionId: string, entry: Given, held: Held, plan: TurnPlan | null) => {
    const known = { ...entry.orcaRules, name: currentBotName(entry.botId) ?? entry.orcaRules.name }
    return withBotRulesUpdate(known, held, plan, (orcaRules) => update(sessionId, { orcaRules }))
  }
  return {
    launched: (sessionId, botId, folder, files, delivered, orcaRules) => {
      record.started(botId, files.memory)
      given.set(
        sessionId,
        launchedBotTurnGiven({
          botId,
          folder,
          files,
          delivered,
          memoryRecord: record.version(botId),
          skillProjects: linkedProjectsKey(linkedSkills.launchScanned(sessionId)),
          orcaRules
        })
      )
      // What memory/ held at launch is what the agent can have read; a turn before this lands takes it.
      void readTopics(folder).then((topics) => {
        if (given.get(sessionId)?.topics === null) {
          update(sessionId, { topics })
        }
      })
    },
    linkedSkillsLaunched: (sessionId, section, delivered) =>
      update(sessionId, { skillsNow: section, skills: delivered ? fingerprint(section) : null }),
    // A worker's report or an attachment starts turns too; the skills replacement must not wait for
    // a person's words.
    launchedInstructions: (sessionId) => {
      const entry = given.get(sessionId)
      return entry ? botLaunchedInstructions(entry.orcaRules) : null
    },
    launchUpdate: async (sessionId, held) => {
      const stored = given.get(sessionId)
      if (!stored) {
        return null
      }
      const receiptVersion = record.version(stored.botId)
      const [entry, memory, topics, unanswered] = await Promise.all([
        relinked(sessionId, stored),
        fs.readText(join(stored.folder, 'MEMORY.md')),
        readTopics(stored.folder),
        unansweredQuestionNote(sessionId).catch(() => null)
      ])
      update(sessionId, {
        memoryAtStart: fingerprint(memory),
        receiptAtStart: { memory, topics, version: receiptVersion },
        topicsAtStart: botMemoryTopicsKey(topics),
        ...(entry.topics ? {} : { topics })
      })
      const rules = firstRun.rules(stored.botId, sessionId)
      const skillsNow = skillsUpdate(entry)
      const text = [rules, skillsNow?.text, unanswered].filter(Boolean)
      const taken = () => (skillsNow ? update(sessionId, { skills: skillsNow.skills }) : undefined)
      const plan = text.length === 0 ? null : { text: text.join('\n\n'), given: taken }
      return withOrcaRules(sessionId, entry, held, plan)
    },
    plan: async (sessionId, message, held) => {
      const stored = given.get(sessionId)
      if (!stored) {
        return null
      }
      const receiptVersion = record.version(stored.botId)
      const [entry, files, work, topics, recent, unanswered] = await Promise.all([
        relinked(sessionId, stored),
        readBotHomeFiles(fs, stored.folder),
        workNote(sessionId, message).catch(() => null),
        readTopics(stored.folder),
        recentChats(stored.botId, sessionId, message).catch(() => null),
        unansweredQuestionNote(sessionId).catch(() => null)
      ])
      const soul = fingerprint(files.soul)
      const memory = fingerprint(files.memory)
      const memoryRecord = record.version(entry.botId)
      update(sessionId, {
        memoryAtStart: memory,
        receiptAtStart: { memory: files.memory, topics, version: receiptVersion },
        topicsAtStart: botMemoryTopicsKey(topics),
        ...(entry.topics ? {} : { topics })
      })
      const skillsNow = skillsUpdate(entry)
      const rules = firstRun.rules(entry.botId, sessionId)
      const memoryNow =
        memory !== entry.memory ? botMemoryUpdateText(entry.memoryText, files.memory) : null
      const topicsNow = entry.topics ? botMemoryTopicsUpdateText(entry.topics, topics) : null
      const others = recent && recent.key !== entry.recentChats ? recent.text : null
      const changed: BotContextChange[] = [
        ...(soul !== entry.soul ? ['soul' as const] : []),
        ...(memoryNow || topicsNow ? ['memory' as const] : [])
      ]
      if (changed.length === 0 && !work && !skillsNow && !rules && !others && !unanswered) {
        return withOrcaRules(sessionId, entry, held, null)
      }
      return withOrcaRules(sessionId, entry, held, {
        text: [
          ...(rules ? [rules] : []),
          ...(soul !== entry.soul ? [`${COPY.soul}\n\n${files.soul?.trim() || '(empty)'}`] : []),
          ...(memoryNow ? [memoryNow] : []),
          ...(topicsNow ? [topicsNow] : []),
          ...(skillsNow ? [skillsNow.text] : []),
          ...(others ? [others] : []),
          ...(work ? [work] : []),
          ...(unanswered ? [unanswered] : [])
        ].join('\n\n'),
        ...(changed.length > 0
          ? { note: botContextNoteBody({ botId: entry.botId, changed }) }
          : {}),
        given: () =>
          update(sessionId, {
            soul,
            memory,
            memoryText: botMemoryKnown(entry.memoryText, files.memory),
            memoryRecord,
            topics,
            ...(recent ? { recentChats: recent.key } : {}),
            ...(skillsNow ? { skills: skillsNow.skills } : {})
          })
      })
    },
    handedOver: (sessionId) =>
      update(sessionId, { memoryAtStart: null, topicsAtStart: null, receiptAtStart: null }),
    // The bot's own SOUL.md or MEMORY.md edit is what its next turn already knows; any other change
    // stays unrecorded so the next turn sends it. A MEMORY.md change made during the turn is the
    // bot's own, however it wrote it, unless Orca saw another writer: a record change (another
    // chat's turn end, Settings, Forget, Undo, tidy-up) or a turn of another chat running beside it.
    // One made before the turn started is never its own. SOUL.md, which has no record, counts only
    // the turn's edit rows.
    turnEnded: (sessionId, turnId, readItems, writeNote) => {
      const entry = given.get(sessionId)
      if (!entry) {
        return
      }
      const { memoryAtStart, topicsAtStart, receiptAtStart } = entry
      update(sessionId, { memoryAtStart: null, topicsAtStart: null, receiptAtStart: null })
      void record
        .after(
          entry.botId,
          async (recorded) => {
            const soul = await fs.readText(join(entry.folder, 'SOUL.md'))
            const since = given.get(sessionId)?.scannedThrough ?? entry.scannedThrough
            const journal = await readItems(since)
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
            // memory/ by the MEMORY.md rule, with no record: the turn's own when it ran alone, from
            // the files the agent had at its start.
            const hadTopics = given.get(sessionId)?.topics
            if (edited && hadTopics && botMemoryTopicsKey(hadTopics) === topicsAtStart) {
              if (botMemoryTopicsKey(topics) !== topicsAtStart && (await alone())) {
                update(sessionId, { topics })
              }
            }
            // Not known yet: everything in the file is new.
            const before = recorded ?? ''
            const keepOut = await readdGuard(fs, entry, record, turn)
            const tagged = await tagBotMemoryFile(fs, entry.folder, before, label, keepOut)
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
              writeNote
            )
            if (!tagged) {
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
          sessionId
        )
        .catch(() => {})
    }
  }
}
