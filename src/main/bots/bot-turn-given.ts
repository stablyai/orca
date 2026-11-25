// What a bot chat's agent was given, as far as Orca knows: per session, in memory.
import type { BotMemoryTopics } from './bot-turn-memory-update'
import { botMemoryKnown, botTurnFingerprint as fingerprint } from './bot-turn-memory-update'
import type { BotTurnSkills } from './bot-turn-linked-skills'
import type { BotTurnMemorySnapshot } from './bot-turn-memory-receipt'
import type { BotHomeFiles } from './bot-preamble'
import {
  botLaunchedTurnRules,
  type BotLaunchedRules,
  type BotTurnRules
} from './bot-turn-rules-update'

/** Null: the agent's copy is unknown, so the next turn sends the file. */
export type BotTurnGiven = BotTurnSkills & {
  folder: string
  soul: string | null
  memory: string | null
  /** What the agent knows of MEMORY.md (`botMemoryKnown`), so a change sends only its lines; null:
   *  unknown. */
  memoryText: string | null
  /** memory/ as the agent has seen it; null: unknown, so the next turn takes it as seen. */
  topics: BotMemoryTopics | null
  /** memory/ when the running turn started (its key); null: unchecked. */
  topicsAtStart: string | null
  /** The other chats' section the agent was given (its key); null: none yet. */
  recentChats: string | null
  /** The record's version when `memory` was set: a change since by another writer is outside. */
  memoryRecord: number
  /** MEMORY.md when the running turn started; null: unchecked, so nothing it holds is the turn's. */
  memoryAtStart: string | null
  receiptAtStart: BotTurnMemorySnapshot | null
  /** The journal read through at the last turn end; null before the first. */
  scannedThrough: number | null
  /** Orca's Tools and Rules: the host's now, and what the agent holds. */
  orcaRules: BotTurnRules
}

/** What a launch gave its agent: the files when `delivered`, and nothing yet of memory/ or turns. */
export function launchedBotTurnGiven(launch: {
  botId: string
  folder: string
  files: BotHomeFiles
  delivered: boolean
  memoryRecord: number
  skillProjects: string | null
  orcaRules: BotLaunchedRules
}): BotTurnGiven {
  const { files, delivered } = launch
  return {
    botId: launch.botId,
    folder: launch.folder,
    soul: delivered ? fingerprint(files.soul) : null,
    memory: delivered ? fingerprint(files.memory) : null,
    memoryText: delivered ? botMemoryKnown(null, files.memory) : null,
    topics: null,
    topicsAtStart: null,
    recentChats: null,
    memoryRecord: launch.memoryRecord,
    memoryAtStart: null,
    receiptAtStart: null,
    scannedThrough: null,
    skillsNow: null,
    skills: fingerprint(null),
    skillProjects: launch.skillProjects,
    orcaRules: botLaunchedTurnRules(launch.orcaRules)
  }
}
