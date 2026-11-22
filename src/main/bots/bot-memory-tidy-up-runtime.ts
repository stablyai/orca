// The runtime's one Tidy-up runner, ticked with Look around's on the automation scheduler.
import { open, readdir, readFile } from 'node:fs/promises'
import { isBotBackgroundRun } from './bot-background-run-records'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Bot } from '../../shared/bot-types'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { botTurns, runtimeBotAutomationSessions } from './bot-automation-sessions'
import { systemBackgroundRunPower } from './bot-background-run-power'
import { requireStructuredHost } from './bot-chat-session'
import { botChatReads } from './bot-chat-reads'
import { tidyUpNoteBody } from '../../shared/bots/bot-tidy-up'
import { noteInChat, writeInChat } from './bot-chat-status-line'
import { botHomeFolder, localBotHomeFilesystem } from './bot-home'
import { LOOK_FAILURES_TO_TURN_OFF } from './bot-look-around-failures'
import {
  chatsSpokenInSince,
  ownerChatLines,
  TIDY_UP_ARCHIVE,
  TIDY_UP_CHATS,
  TIDY_UP_MEMORY_FILES,
  type TidyUpChat,
  type TidyUpMemoryFile
} from './bot-memory-tidy-up'
import { hostSalvageStore } from './bot-memory-salvage-store'
import { BotTidyUpRunner } from './bot-memory-tidy-up-runner'
import { watchBotTurnEnds } from './bot-run-turn-watch'

const runners = new WeakMap<object, BotTidyUpRunner>()

function botSessions(bot: Bot) {
  return (readAgentSessionRecordStore()?.listRecords() ?? []).filter(
    (record) => botOfHomeWorkspace([bot], record.location.workspaceId) !== null
  )
}

/** A file's text, or just enough of its start or end to hold `chars` of its trimmed text. */
async function readMemoryFile(path: string, chars: number, from: 'start' | 'end'): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    // A UTF-16 unit is at most 3 UTF-8 bytes, and the cut may split one character.
    const length = Math.min(size, chars * 3 + 3)
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(length),
      0,
      length,
      from === 'start' ? 0 : size - length
    )
    if (length === size) {
      return buffer.toString('utf8', 0, bytesRead)
    }
    let skip = 0
    while (from === 'end' && skip < 3 && (buffer[skip] & 0xc0) === 0x80) {
      skip++
    }
    const text =
      from === 'start'
        ? new StringDecoder('utf8').write(buffer.subarray(0, bytesRead))
        : buffer.toString('utf8', skip, bytesRead)
    // Mostly whitespace near the cut: the window is short, so read it all.
    return text.trim().length >= chars ? text : await readFile(path, 'utf8')
  } finally {
    await handle.close()
  }
}

/** The memory files as far as the prompt reads them: topics in name order until their budget is
 *  used, and the archive's end. */
async function memoryFiles(folder: string): Promise<TidyUpMemoryFile[]> {
  const names = await readdir(join(folder, 'memory')).catch(() => [])
  const files: TidyUpMemoryFile[] = []
  let topicChars = 0
  for (const file of names.filter((name) => name.endsWith('.md')).toSorted()) {
    const name = file.slice(0, -'.md'.length)
    const archive = name === TIDY_UP_ARCHIVE
    if (!archive && topicChars >= TIDY_UP_MEMORY_FILES.topics) {
      continue
    }
    const text = await readMemoryFile(
      join(folder, 'memory', file),
      archive ? TIDY_UP_MEMORY_FILES.archive : TIDY_UP_MEMORY_FILES.topic,
      archive ? 'end' : 'start'
    ).catch(() => '')
    if (text.trim() === '') {
      continue
    }
    files.push({ name, text })
    if (!archive) {
      topicChars += Math.min(text.trim().length, TIDY_UP_MEMORY_FILES.topic)
    }
  }
  return files
}

const turnedOff = (lastError: string): string =>
  `Tidy-up turned off: the last ${LOOK_FAILURES_TO_TURN_OFF} tidy-ups failed. ${lastError}`

export function runtimeTidyUpRunner(runtime: OrcaRuntimeService): BotTidyUpRunner {
  const existing = runners.get(runtime)
  if (existing) {
    return existing
  }
  const store = runtime.lookAround
  const runner = new BotTidyUpRunner({
    bots: () => (runtime.bots.enabled() ? runtime.bots.list() : []),
    store,
    newChats: async (bot, since) => {
      const reads = botChatReads(runtime)
      const chats: TidyUpChat[] = []
      // Newest first, and no more than the prompt reads.
      for (const record of chatsSpokenInSince(botSessions(bot), since)) {
        if (chats.length === TIDY_UP_CHATS.max) {
          break
        }
        const { sessionId } = record
        if (isBotBackgroundRun(store, record)) {
          continue
        }
        const lines = ownerChatLines(await reads.messagesSince(sessionId, since), since)
        if (lines.some(({ by }) => by === 'owner')) {
          chats.push({ title: record.conversationName ?? null, lines })
        }
      }
      return chats
    },
    busy: (bot) => botSessions(bot).some(({ sessionId }) => botTurns.running(sessionId)),
    memory: runtime.bots.memory,
    fs: localBotHomeFilesystem,
    salvage: hostSalvageStore(),
    memoryFiles,
    homeFolder: (bot) => botHomeFolder(bot),
    sessions: runtimeBotAutomationSessions(runtime),
    stopTurn: botTurns.stop,
    turnRunning: botTurns.running,
    watchTurns: async () => watchBotTurnEnds(await requireStructuredHost(runtime)),
    noteTidied: (bot, note) =>
      writeInChat(bot.chatSessionId ?? undefined, tidyUpNoteBody(note), 'tidy-up'),
    turnOff: async (bot, lastError) => {
      await runtime.bots.update(bot.id, { tidyUp: { on: false } })
      noteInChat(bot.chatSessionId ?? undefined, turnedOff(lastError))
    },
    power: systemBackgroundRunPower(),
    now: Date.now
  })
  runners.set(runtime, runner)
  return runner
}
