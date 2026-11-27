// What a Tidy-up runner needs from its host: the bots, their chats and memory, the run's session,
// and, for a pilot bot's status move, salvage's record and the owner's names.
import type { Bot } from '../../shared/bot-types'
import type { BotTidyUpNote } from '../../shared/bots/bot-tidy-up'
import type { BotAutomationSessions } from '../automations/bot-automation-launch'
import type { BackgroundRunPower } from './bot-background-run'
import type { BotLookAroundStore } from './bot-look-around-store'
import type { BotMemoryRecord } from './bot-memory-record'
import type { BotSalvageStore } from './bot-memory-salvage-store'
import type { TidyUpChat, TidyUpMemoryFile } from './bot-memory-tidy-up'
import type { TidyUpFiles } from './bot-memory-ops-pilot'
import type { BotTurnWatch } from './bot-run-turn-watch'

export type BotTidyUpRunnerDeps = {
  bots: () => readonly Bot[]
  store: Pick<BotLookAroundStore, 'get' | 'update'>
  /** The bot's chats with lines from its owner since `since`, newest first and only as many as the
   *  prompt reads; never its looks or tidy-ups. */
  newChats: (bot: Bot, since: number) => Promise<TidyUpChat[]>
  /** Whether any of the bot's conversations is running a turn. */
  busy: (bot: Bot) => boolean
  memory: Pick<BotMemoryRecord, 'change' | 'history'>
  fs: TidyUpFiles
  /** The owner's names, for reading which lines are the owner deciding (pilot bots only). */
  ownerNames?: () => Promise<string[]>
  /** Where the status move's lines are noted for salvage. */
  salvage?: Pick<BotSalvageStore, 'recordMoved'>
  /** The files in the bot's memory/ folder, the archive among them, as far as the prompt reads. */
  memoryFiles: (folder: string) => Promise<TidyUpMemoryFile[]>
  homeFolder: (bot: Bot) => string
  sessions: Pick<BotAutomationSessions, 'startConversation' | 'release'>
  watchTurns: () => Promise<BotTurnWatch>
  stopTurn: (sessionId: string) => Promise<void>
  turnRunning: (sessionId: string) => boolean
  /** A line in the bot's Home Chat: this tidy-up changed something. */
  noteTidied: (bot: Bot, note: BotTidyUpNote) => void
  /** Turns the bot's Tidy-up off after too many failed runs in a row, saying why. */
  turnOff: (bot: Bot, lastError: string) => Promise<void>
  power: BackgroundRunPower
  now: () => number
}
