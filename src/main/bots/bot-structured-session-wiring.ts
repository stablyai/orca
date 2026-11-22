// A host's structured-session wiring for bots: preambles, own tools, the turn context, and look-around turns.
import type { Bot } from '../../shared/bot-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { KnownPairedBotRoster } from './paired-bot-rosters'
import type { StructuredAgentSessionRuntimeDeps } from '../runtime/agent-session/installation/structured-agent-session-runtime-contract'
import { botHomeFolder, localBotHomeFilesystem } from './bot-home'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { createBotLookupIndex } from '../../shared/bots/bot-lookup-index'
import type { BotLookAroundStore } from './bot-look-around-store'
import { botSessionToolServers, currentBotToolsRevision } from './bot-tools-file'
import { botToolsEpoch, type BotLaunchedTools } from './bot-tools-revision'
import { createBotTurnContext } from './bot-turn-context'
import type { TurnEndedVerdict } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { BotChatJournal } from './bot-turn-rows'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { BOT_FIRST_RUN_RULES } from './bot-preamble'
import { linkBotOwnSkills } from './bot-own-skills'
import { botSessionInstructions } from './bot-session-instructions'
import { createBotSessionMentions } from './bot-session-mentions'
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
import type { Repo } from '../../shared/repository/repo-types'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'

/** The agents that reload a watched skills folder mid-chat (checked on Claude 2.1.319, Codex 0.163). */
const LIVE_SKILLS_PROVIDERS = new Set(['claude', 'codex'])

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
  requestTurnEnded?: (sessionId: string, turnId: string, ended?: TurnEndedVerdict) => void
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
  /** A paired computer's name while it is connected; null otherwise. */
  clientName?: (installationId: string) => string | null
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
  const lookup = createBotLookupIndex(() => deps.store().getBots?.() ?? [])
  const botById = (botId: string): Bot | undefined => lookup.byId(botId)
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
    deps.unansweredQuestionNote,
    (botId) => botById(botId)?.name ?? null
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
    lookup.byHome(record.location.workspaceId)
  /** The bot's linked-skills folder brought up to date; rejects when it can't be. */
  const syncLinkedSkills = (bot: Bot): Promise<LinkedSkills> =>
    linkedSkillProjects(bot, deps.store().getRepos(), botLinkedSkillsFolder(bot.id))
  const mentions = createBotSessionMentions({
    botById,
    botChats: deps.botChats,
    pairedBotRosters: deps.pairedBotRosters,
    clientName: deps.clientName
  })
  return {
    resolveSessionInstructions: (record, launchDirectory, linkedSkills) => {
      const bot = botOfRecord(record)
      return botSessionInstructions(
        turnContext,
        bot ? [bot] : [],
        record,
        launchDirectory,
        linkedSkills
      )
    },
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
        await linkBotOwnSkills(botHomeFolder(bot)).catch((error: unknown) => {
          console.warn("[bots] the bot's own skills could not be linked", bot.id, error)
        })
      }
    },
    resolveSessionToolServers: async (record, launchDirectory) => {
      const bot = botOfRecord(record)
      const { tools, launched } = await botSessionToolServers(
        bot ? [bot] : [],
        record,
        launchDirectory
      )
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
      mentions,
      handedOver: (sessionId, message) => {
        deps.work.handedOver(sessionId, message)
        turnContext.handedOver?.(sessionId, message)
      },
      turnEnded: (sessionId, turnId, readItems, writeNote, ended) => {
        deps.work.turnEnded(sessionId)
        deps.requestTurnEnded?.(sessionId, turnId, ended)
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
    isBotHome: (workspaceId) => lookup.byHome(workspaceId) !== null
  }
}
