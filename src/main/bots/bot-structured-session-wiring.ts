// A host's structured-session wiring for bots: preambles, own tools, the turn context, and look-around turns.
import type { Bot } from '../../shared/bot-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { KnownPairedBotRoster } from './paired-bot-rosters'
import type { StructuredAgentSessionRuntimeDeps } from '../runtime/agent-session/installation/structured-agent-session-runtime-contract'
import { join } from 'node:path'
import { botHomeFolder, localBotHomeFilesystem } from './bot-home'
import { messageWords } from '../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import {
  botMentionContext,
  mentionedBots,
  mentionedServerBots,
  type BotMentionChat
} from '../../shared/bots/bot-mention-context'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { soulSpecialty } from '../../shared/bot-roster'
import type { BotLookAroundStore } from './bot-look-around-store'
import { botSessionToolServers, currentBotToolsRevision } from './bot-tools-file'
import { botToolsEpoch, type BotLaunchedTools } from './bot-tools-revision'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import { createBotTurnContext } from './bot-turn-context'
import type { TurnEndedVerdict } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { BotChatJournal } from './bot-turn-rows'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { BOT_FIRST_RUN_RULES } from './bot-preamble'
import { botSessionInstructions } from './bot-session-instructions'
import type { BotController } from './bot-controller'
import type { BotWorkRecord } from './bot-work-record'
import {
  botLinkedSkillsFolder,
  linkedSkillListing,
  linkedSkillProjects
} from './bot-skill-projects'
import {
  linkedSkillsSection,
  NO_LINKED_SKILLS,
  type LinkedSkills
} from '../native-chat/native-chat-skill-roots'

/** The agents that reload a watched skills folder mid-chat (checked on Claude 2.1.319, Codex 0.163). */
const LIVE_SKILLS_PROVIDERS = new Set(['claude', 'codex'])
import type { Repo } from '../../shared/repository/repo-types'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'

/** A bot as the session host's wiring sees it. */
export type WiredBot = Bot

export function botStructuredSessionWiring(deps: {
  /** The host's bots, and its projects, which bots link for skills. */
  store: () => { getBots?: () => readonly Bot[]; getRepos: () => readonly Repo[] }
  /** First-run setup's end, and each bot's MEMORY.md as Orca last recorded it. */
  bots: Pick<BotController, 'endFirstRun' | 'memory'>
  /** The bot's chats as a turn end reads them. */
  chats: BotChatJournal
  /** Which worker a turn's conversation handed its code work to. */
  work: Pick<BotWorkRecord, 'turnNote' | 'handedOver' | 'turnEnded'>
  lookAround: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp' | 'lookTurnIsQuiet'>
  /** A turn ended: one that worked on another bot's request and left it unanswered tells that bot. */
  requestTurnEnded?: (sessionId: string, ended?: TurnEndedVerdict) => void
  /** The bots the host holds when this is installed; none when it has no store yet. */
  botsAtInstall?: readonly Bot[]
  /** What the bot's other chats did lately, as a turn of this chat may hear of it. */
  recentChats?: (
    botId: string,
    sessionId: string,
    message: AgentJournalMessageItem
  ) => Promise<BotRecentChatsSection | null>
  /** The every-fifth-turn note on questions an owner chat left unanswered; null on other turns. */
  unansweredQuestionNote?: (sessionId: string) => Promise<string | null>
  /** A bot's chats on this host, each with whether it takes mail, as `sessionId` asks. */
  botChats?: (bot: Bot, sessionId: string) => Promise<readonly BotChatRow[]>
  /** The bots on these paired servers as last read, without waiting on the network. */
  pairedBotRosters?: (servers: ReadonlySet<string>) => Promise<readonly KnownPairedBotRoster[]>
  /** Moves saved values an older Orca left behind out of reach; a launch waits for it. */
  scrubToolSecrets?: (bot: Bot) => Promise<void>
}): Required<
  Pick<
    StructuredAgentSessionRuntimeDeps,
    | 'resolveSessionInstructions'
    | 'resolveSessionToolServers'
    | 'launchTools'
    | 'resolveSessionLinkedSkills'
    | 'prepareSessionLinkedSkills'
    | 'reportSessionLinkedSkills'
    | 'prepareSessionLaunch'
    | 'turnContext'
    | 'readOnlySession'
    | 'quietTurnEnd'
    | 'isBotHome'
  >
> {
  const bots = (): readonly Bot[] => deps.store().getBots?.() ?? []
  /** The paired servers' bots a message names, as each server last listed them, so a send never
   *  waits on another computer; one on a server this host isn't paired to, or one its server no longer
   *  lists, adds nothing. */
  const serverBotLines = async (words: string) => {
    const picks = mentionedServerBots(words)
    if (picks.length === 0 || !deps.pairedBotRosters) {
      return []
    }
    const rosters = await deps
      .pairedBotRosters(new Set(picks.map((pick) => pick.server)))
      .catch(() => [])
    return picks.flatMap((pick) => {
      const roster = rosters.find((entry) => entry.environmentId === pick.server)
      if (!roster) {
        return []
      }
      // Not read yet: the pick names it as picked, and its send says if it can't go.
      const listed = roster.bots?.find((bot) => bot.id === pick.id)
      if (roster.bots && !listed) {
        return []
      }
      return [
        {
          id: pick.id,
          name: listed?.name ?? pick.name,
          purpose: listed?.specialty ?? null,
          server: roster.server
        }
      ]
    })
  }
  const botById = (botId: string): Bot | undefined => bots().find((bot) => bot.id === botId)
  /** Only a new bot's Chat runs first run; its automations and threads run in the same home without. */
  const inFirstRun = (botId: string, sessionId: string): boolean => {
    const bot = botById(botId)
    return bot?.firstRun === true && bot.chatSessionId === sessionId
  }
  /** The projects each session's launch scanned, so a later link is told apart from them. */
  const launchScans = new Map<string, readonly string[] | null>()
  /** The tools each chat's running agent launched with; a chat with none here never refreshes. */
  const launchedTools = new Map<string, BotLaunchedTools>()
  /** Chats whose agent loaded the bot's folder and rereads it: a change needs only the names. */
  const liveSkills = new Set<string>()
  const turnContext = createBotTurnContext(
    localBotHomeFilesystem,
    {
      rules: (botId, sessionId) => (inFirstRun(botId, sessionId) ? BOT_FIRST_RUN_RULES : null),
      ownerTurnEnded: (botId, sessionId) => {
        if (inFirstRun(botId, sessionId)) {
          void deps.bots.endFirstRun(botId).catch(() => {})
        }
      }
    },
    deps.chats,
    (sessionId, message) => deps.work.turnNote(sessionId, message),
    deps.bots.memory,
    {
      projects: (botId) => botById(botId)?.skillProjects ?? null,
      launchScanned: (sessionId) => launchScans.get(sessionId) ?? null,
      listed: async (botId, projects, sessionId) => {
        const repos = deps.store().getRepos()
        if (!liveSkills.has(sessionId)) {
          const linked = await linkedSkillListing(projects, repos)
          return linkedSkillsSection(linked, linked)
        }
        // The running agent rereads the folder, so it is brought up to date before the names go.
        const linked = await linkedSkillProjects(
          { skillProjects: [...projects] },
          repos,
          botLinkedSkillsFolder(botId)
        )
        return linkedSkillsSection(linked.projects, [], true)
      }
    },
    deps.recentChats,
    deps.unansweredQuestionNote
  )
  // The host's bots at install move their saved values out now, not when each next launches.
  const scrub = deps.scrubToolSecrets
  if (scrub) {
    void Promise.allSettled((deps.botsAtInstall ?? []).map((bot) => scrub(bot))).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(
            "[bots] moving a bot's saved tool values failed; its next launch retries",
            result.reason
          )
        }
      }
    })
  }
  const botOfRecord = (record: AgentSessionRecord): Bot | null =>
    botOfHomeWorkspace(bots(), record.location.workspaceId)
  /** The bot's linked-skills folder brought up to date; rejects when it can't be. */
  const syncLinkedSkills = (bot: Bot): Promise<LinkedSkills> =>
    linkedSkillProjects(bot, deps.store().getRepos(), botLinkedSkillsFolder(bot.id))
  return {
    resolveSessionInstructions: (record, launchDirectory, linkedSkills) =>
      botSessionInstructions(turnContext, bots(), record, launchDirectory, linkedSkills),
    // The agent turned its roots down after launch: its next turn gets the list.
    reportSessionLinkedSkills: (sessionId, linkedSkills) => {
      // Later links reach it as a list with paths; an empty folder left it nothing to resend.
      liveSkills.delete(sessionId)
      if (linkedSkills !== null) {
        turnContext.linkedSkillsLaunched(sessionId, linkedSkills, false)
      }
    },
    // Every launch of a bot's chat, Look around too: a copy left in its config would be readable by it.
    prepareSessionLaunch: async (record) => {
      const bot = botOfRecord(record)
      if (bot) {
        await deps.scrubToolSecrets?.(bot)
      }
    },
    resolveSessionToolServers: async (record, launchDirectory) => {
      const { tools, launched } = await botSessionToolServers(bots(), record, launchDirectory)
      if (launched) {
        launchedTools.set(record.sessionId, launched)
      } else {
        launchedTools.delete(record.sessionId)
      }
      return tools
    },
    launchTools: {
      changed: async (sessionId) => {
        const launched = launchedTools.get(sessionId)
        return (
          launched !== undefined &&
          (await currentBotToolsRevision(launched.folder)) !== launched.revision
        )
      },
      outdated: (sessionId) => {
        const launched = launchedTools.get(sessionId)
        return launched !== undefined && botToolsEpoch(launched.folder) !== launched.epoch
      }
    },
    prepareSessionLinkedSkills: async (record) => {
      const bot = botOfRecord(record)
      return bot ? syncLinkedSkills(bot) : NO_LINKED_SKILLS
    },
    resolveSessionLinkedSkills: async (record) => {
      const bot = botOfRecord(record)
      if (!bot) {
        return NO_LINKED_SKILLS
      }
      try {
        const linked = await syncLinkedSkills(bot)
        launchScans.set(record.sessionId, bot.skillProjects ?? null)
        if (LIVE_SKILLS_PROVIDERS.has(record.provider)) {
          liveSkills.add(record.sessionId)
        } else {
          liveSkills.delete(record.sessionId)
        }
        return linked
      } catch (error) {
        // The chat starts without the folder; its turns list the skills instead.
        console.warn('[bots] linked project skills could not be prepared', bot.id, error)
        launchScans.delete(record.sessionId)
        liveSkills.delete(record.sessionId)
        return NO_LINKED_SKILLS
      }
    },
    turnContext: {
      ...turnContext,
      // Any chat: a bot picked under `@` is named `[Bot: <name>](bot:<id>)`, one on a paired server
      // `(bot:<id>@<server>)`, one of its chats `(bot-chat:<id>/<chat>)`; a bot's own chat may insert
      // `@name`. Only this host's bots and its paired servers' resolve.
      mentions: async (sessionId, message) => {
        const words = messageWords(message)
        const named = mentionedBots(words, bots())
        const remote = serverBotLines(words)
        const chatsOf = new Map<string, Promise<readonly BotChatRow[] | null>>()
        const readChats = (bot: Bot) => {
          let read = chatsOf.get(bot.id)
          if (!read) {
            read = (deps.botChats?.(bot, sessionId) ?? Promise.resolve(null)).catch(() => null)
            chatsOf.set(bot.id, read)
          }
          return read
        }
        return botMentionContext([
          ...(await Promise.all(
            named.map(async ({ bot, chatId }) => {
              const [soul, chat] = await Promise.all([
                localBotHomeFilesystem.readText(join(botHomeFolder(bot), 'SOUL.md')),
                chatId === null
                  ? undefined
                  : readChats(bot).then((rows) => checkedChat(rows, chatId))
              ])
              return {
                id: bot.id,
                name: bot.name,
                purpose: soulSpecialty(soul),
                ...(chat ? { chat } : {})
              }
            })
          )),
          ...(await remote)
        ])
      },
      handedOver: (sessionId, message) => {
        deps.work.handedOver(sessionId, message)
        turnContext.handedOver?.(sessionId, message)
      },
      turnEnded: (sessionId, turnId, readItems, writeNote, ended) => {
        deps.work.turnEnded(sessionId)
        deps.requestTurnEnded?.(sessionId, ended)
        turnContext.turnEnded?.(sessionId, turnId, readItems, writeNote)
      }
    },
    // A look reads through its allow-list; a tidy-up only replies, its new memory in its reply.
    readOnlySession: (sessionId) =>
      deps.lookAround.botOfLook(sessionId) !== null
        ? 'look-around'
        : deps.lookAround.botOfTidyUp(sessionId) !== null
          ? 'reply-only'
          : null,
    quietTurnEnd: (sessionId, outcome, usageLimited) =>
      deps.lookAround.lookTurnIsQuiet(sessionId, outcome, usageLimited === true),
    isBotHome: (workspaceId) => botOfHomeWorkspace(bots(), workspaceId) !== null
  }
}

/** A picked chat as the host's own list has it: `--chat` only for one of the bot's chats that takes
 *  mail; any doubt (an unread list included) says it can't, and never falls back to the Home Chat. */
function checkedChat(rows: readonly BotChatRow[] | null, chatId: string): BotMentionChat {
  if (!rows) {
    return { refused: 'unverifiable' }
  }
  const row = rows.find((entry) => entry.id === chatId)
  if (!row) {
    return { refused: 'not-its-chat' }
  }
  if (row.self) {
    return { refused: 'self' }
  }
  return row.closed ? { refused: row.reason ?? 'unverifiable' } : { id: row.id, title: row.title }
}
