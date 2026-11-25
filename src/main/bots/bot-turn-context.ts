// A running bot chat hears of outside memory changes and receipts its own committed writes.
import { createBotTurnCompletion } from './bot-turn-completion'
import { createBotInstructionDelivery } from './bot-instruction-delivery'
import type { BotTurnContextState as Given } from './bot-turn-context-contract'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  type BotMemoryTopics,
  botMemoryTopicsKey,
  botMemoryTopicsUpdateText,
  botMemoryUpdateText,
  botMemoryKnown,
  botSoulUpdateText,
  botTurnFingerprint as fingerprint,
  readBotMemoryTopics
} from './bot-turn-memory-update'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { type BotTurnNoteRead, withNoteGiven } from './bot-active-work'
import {
  type BotTurnLinkedSkills,
  linkedProjectsKey,
  linkedSkillsUpdate as skillsUpdate,
  NO_BOT_TURN_LINKED_SKILLS,
  relinkedSkills
} from './bot-turn-linked-skills'
import type { BotTurnContext, BotFirstRun, Held } from './bot-turn-context-types'
import type { StructuredAgentSessionTurnContextPlan as TurnPlan } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botLaunchedInstructions, withBotRulesUpdate } from './bot-turn-rules-update'
import { launchedBotTurnGiven } from './bot-turn-given'
import { NO_BOT_CHAT_JOURNAL } from './bot-turn-rows'
import { botContextNoteBody, type BotContextChange } from '../../shared/bots/bot-context-note'
import { readBotHomeFiles } from './bot-preamble'
import type { BotHomeFilesystem } from './bot-home'
import { type BotMemoryRecord, createBotMemoryRecord } from './bot-memory-record'

export { BOT_MEMORY_UPDATED_NOTE } from '../../shared/bots/bot-memory-updated-note'

export type { BotTurnContext, BotFirstRun } from './bot-turn-context-types'

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
    sessionId: string
  ) => Promise<BotRecentChatsSection | null> = async () => null,
  /** Every fifth turn of an owner chat, whoever started it: questions the owner left unanswered; and
   *  In progress items nothing runs for, each said once until it changes. */
  unansweredQuestionNote: BotTurnNoteRead = async () => null,
  /** Current metadata, so a rename also reaches an already-running chat. */
  currentBotName: (botId: string) => string | null = () => null
): BotTurnContext {
  const readTopics = (folder: string): Promise<BotMemoryTopics> => readBotMemoryTopics(fs, folder)
  // Codex restores proven file digests from its receipt; the remaining turn state stays in memory.
  const given = new Map<string, Given>()
  const launches = new Map<string, object>()
  const update = (sessionId: string, fields: Partial<Omit<Given, 'botId' | 'folder'>>): void => {
    const entry = given.get(sessionId)
    if (entry) {
      given.set(sessionId, { ...entry, ...fields })
    }
  }
  const instructions = createBotInstructionDelivery(
    (sessionId) => given.get(sessionId),
    update,
    fingerprint
  )
  /** A project linked or unlinked since launch makes the list the agent should have now. */
  const relinked = async (
    sessionId: string,
    entry: Given,
    launch: object | undefined
  ): Promise<Given> => {
    const next = await relinkedSkills(linkedSkills, sessionId, entry)
    if (next && launches.get(sessionId) === launch) {
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
    configureInstructions: instructions.configure,
    instructionSnapshot: instructions.snapshot,
    instructionsAccepted: instructions.accepted,
    instructionBaseline: (sessionId) => {
      if (instructions.snapshot(sessionId)) {
        return undefined
      }
      const entry = given.get(sessionId)
      if (!entry) {
        return undefined
      }
      const { soul, memory, skills } = entry
      return { soul, memory, skills }
    },
    launched: (sessionId, botId, folder, files, delivered, orcaRules) => {
      const launch = {}
      launches.set(sessionId, launch)
      const prior = given.get(sessionId)
      const retained =
        !delivered && prior?.botId === botId && prior.folder === folder ? prior : undefined
      instructions.forget(sessionId)
      record.started(botId, files.memory)
      given.set(sessionId, {
        ...launchedBotTurnGiven({
          botId,
          folder,
          files,
          delivered,
          memoryRecord: record.version(botId),
          skillProjects: linkedProjectsKey(linkedSkills.launchScanned(sessionId)),
          orcaRules
        }),
        ...(retained
          ? { soul: retained.soul, memory: retained.memory, memoryText: retained.memoryText }
          : {})
      })
      // What memory/ held at launch is what the agent can have read; a turn before this lands takes it.
      void readTopics(folder).then((topics) => {
        if (launches.get(sessionId) === launch && given.get(sessionId)?.topics === null) {
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
      const launch = launches.get(sessionId)
      if (!stored) {
        return null
      }
      const receiptVersion = record.version(stored.botId)
      const [entry, memory, topics, unanswered] = await Promise.all([
        relinked(sessionId, stored, launch),
        fs.readText(join(stored.folder, 'MEMORY.md')),
        readTopics(stored.folder),
        unansweredQuestionNote(sessionId, stored.botId).catch(() => null)
      ])
      if (launches.get(sessionId) !== launch) {
        return null
      }
      update(sessionId, {
        memoryAtStart: fingerprint(memory),
        receiptAtStart: { memory, topics, version: receiptVersion },
        topicsAtStart: botMemoryTopicsKey(topics),
        ...(entry.topics ? {} : { topics })
      })
      const rules = firstRun.rules(stored.botId, sessionId)
      const skillsNow = skillsUpdate(entry)
      const providerInstructions = instructions.snapshot(sessionId) ?? undefined
      const text = [rules, skillsNow?.text, unanswered?.text].filter(Boolean)
      const taken = withNoteGiven(unanswered, () =>
        skillsNow && launches.get(sessionId) === launch
          ? update(sessionId, { skills: skillsNow.skills })
          : undefined
      )
      const plan =
        text.length === 0 && !providerInstructions
          ? null
          : {
              text: text.join('\n\n'),
              ...(providerInstructions ? { providerInstructions } : {}),
              given: () => {
                if (launches.get(sessionId) === launch) {
                  taken()
                }
              }
            }
      return withOrcaRules(sessionId, entry, held, plan)
    },
    plan: async (sessionId, message, held) => {
      const stored = given.get(sessionId)
      const launch = launches.get(sessionId)
      if (!stored) {
        return null
      }
      const receiptVersion = record.version(stored.botId)
      const [entry, files, work, topics, recent, unanswered] = await Promise.all([
        relinked(sessionId, stored, launch),
        readBotHomeFiles(fs, stored.folder),
        workNote(sessionId, message).catch(() => null),
        readTopics(stored.folder),
        recentChats(stored.botId, sessionId).catch(() => null),
        unansweredQuestionNote(sessionId, stored.botId).catch(() => null)
      ])
      if (launches.get(sessionId) !== launch) {
        return null
      }
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
      const providerInstructions = instructions.snapshot(sessionId) ?? undefined
      if (
        changed.length === 0 &&
        !work &&
        !skillsNow &&
        !rules &&
        !others &&
        !unanswered &&
        !providerInstructions
      ) {
        return withOrcaRules(sessionId, entry, held, null)
      }
      return withOrcaRules(sessionId, entry, held, {
        ...(providerInstructions ? { providerInstructions } : {}),
        text: [
          ...(rules ? [rules] : []),
          ...(soul !== entry.soul ? [botSoulUpdateText(files.soul)] : []),
          ...(memoryNow ? [memoryNow] : []),
          ...(topicsNow ? [topicsNow] : []),
          ...(skillsNow ? [skillsNow.text] : []),
          ...(others ? [others] : []),
          ...(work ? [work] : []),
          ...(unanswered ? [unanswered.text] : [])
        ].join('\n\n'),
        ...(changed.length > 0
          ? { note: botContextNoteBody({ botId: entry.botId, changed }) }
          : {}),
        given: () => {
          if (launches.get(sessionId) !== launch) {
            return
          }
          withNoteGiven(unanswered, () =>
            update(sessionId, {
              soul,
              memory,
              memoryText: botMemoryKnown(entry.memoryText, files.memory),
              memoryRecord,
              topics,
              ...(recent ? { recentChats: recent.key } : {}),
              ...(skillsNow ? { skills: skillsNow.skills } : {})
            })
          )()
        }
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
    turnEnded: createBotTurnCompletion({
      fs,
      record,
      given,
      update,
      firstRun,
      chats,
      readTopics,
      capture: (sessionId) => {
        const launch = launches.get(sessionId)
        return () => launches.get(sessionId) === launch
      }
    })
  }
}
