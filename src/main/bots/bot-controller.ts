import {
  type BotStore,
  persistBotStore,
  requireBotStore,
  requireStoredBot
} from './bot-controller-store'
// The bots on this computer, each homed in a folder workspace of the hidden Bots project group.
import { BOT_IMPORT_REPLY_FILE } from '../../shared/bots/bot-import'
import { join } from 'node:path'
import { BOT_AVATAR_FILE, type BotPictureRevision, isUploadAvatar } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import { botFolderName } from '../../shared/bots/bot-folder-name'
import { assertBotNameFree, freeBotName } from './bot-free-name'
import { areHostBotsEnabled, assertHostBotsEnabled } from './bot-team-policy'
import { type BotRosterEntry, botRosterFields, soulSpecialty } from '../../shared/bot-roster'
import {
  applyBotUpdates,
  type BotCreateParams,
  type BotDeleteParams,
  type BotHostUpdates
} from '../../shared/rpc-contract/bots-params'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { proposalSoul } from '../../shared/bots/bot-proposal'
import { botTemplate } from '../../shared/bots/bot-templates'
import { templateBotFolderName } from '../../shared/bots/bot-template-view'
import { botOfferCreation } from './bot-offer-creation'
import { assertBotOwnsHome, type BotHomeFilesystem, botHomeFolder, writeBotHome } from './bot-home'
import { type BotMemoryRecord, hostBotMemoryRecord } from './bot-memory-record'
import { stampBotLinkOwners } from '../../shared/bot-link-owners'
import {
  botForManualPicture,
  knownBotPicture,
  readBotHomePicture,
  writeBotAvatarImage
} from './bot-avatar-revision'
import { makeBotsHome } from './bot-home-workspace'
import { newBotRecord } from './bot-new-record'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'

/** Where a new bot came from, kept on its record. */
export type BotOrigin = Partial<Pick<Bot, 'sharedFrom' | 'templateId'>>

export type BotControllerDependencies = {
  getStore: () => RuntimeStore | null
  /** A bot record was saved or removed; `catalogChanged` when its home workspace was added, renamed
   *  or removed with it, which the project catalog also announces. */
  notifyBotsWritten: (catalogChanged: boolean) => void
  /** The project-group controller's own create, so path checks match any folder workspace's. */
  createFolderWorkspace: (input: {
    projectGroupId: string
    name: string
    folderPath: string
    createdWithAgent: Bot['agent']
  }) => Promise<FolderWorkspace>
  /** Ends the work held in the workspace (terminals, agent status) before it is forgotten. */
  deleteFolderWorkspace: (folderWorkspaceId: string) => Promise<unknown>
  /** Removes the automations that run as the bot, as their own delete does. */
  deleteBotAutomations: (botId: string) => Promise<void>
  /** Saved on another agent: its automations that follow it record that agent. */
  botAgentChanged?: (bot: Bot) => void
  /** Takes the bot out of every group room, as removing it from each would. */
  leaveBotGroups?: (botId: string) => Promise<void>
  botsRoot: () => string
  filesystem: BotHomeFilesystem
  /** The Orca account signed in now, recorded on the links a bot gets. */
  accountUserId?: () => string | null
  /** Drops what this host keeps for a bot outside its record (its Look around), once it is deleted. */
  forgetBot?: (botId: string) => void
}

export class BotController {
  // One change at a time: two creates must never write the same home folder.
  private tail: Promise<unknown> = Promise.resolve()

  /** Each bot's MEMORY.md as Orca last recorded it: turn ends restore against it, Forget edits it. */
  readonly memory: BotMemoryRecord

  constructor(private readonly deps: BotControllerDependencies) {
    this.memory = hostBotMemoryRecord(deps.filesystem)
  }

  /** Off, bots take no conversations or runs, and nothing creates or opens one; their homes stay. */
  enabled(): boolean {
    return areHostBotsEnabled(this.deps.getStore()?.getSettings())
  }

  assertEnabled(): void {
    assertHostBotsEnabled(this.deps.getStore()?.getSettings())
  }

  list(): Bot[] {
    return this.deps.getStore()?.getBots?.() ?? []
  }

  /** A fresh Generate can recover a lost profile save. A concurrent catalog change keeps its original guard. */
  async generationRevision(
    botId: string,
    seen: number,
    epoch?: string
  ): Promise<BotPictureRevision> {
    const store = requireBotStore(this.deps.getStore())
    const listed = requireStoredBot(store, botId)
    const home = await readBotHomePicture(this.deps, listed)
    return this.serialize(async () => {
      const currentStore = requireBotStore(this.deps.getStore())
      const current = requireStoredBot(currentStore, botId)
      if (
        current !== listed ||
        (listed.avatarRevision ?? 0) !== seen ||
        listed.avatarRevisionEpoch !== epoch
      ) {
        return { revision: seen, epoch }
      }
      const bot = knownBotPicture(home)
      if (listed !== bot) {
        currentStore.saveBot(bot)
        this.deps.notifyBotsWritten(false)
      }
      return { revision: bot.avatarRevision ?? 0, epoch: bot.avatarRevisionEpoch }
    })
  }

  /** The list with what a client needs to draw it as this host's own sidebar does. */
  listing(): { bots: Bot[]; botsEnabled: boolean; hideBotCreatedWorkspaces: boolean } {
    return {
      bots: this.list(),
      botsEnabled: this.enabled(),
      hideBotCreatedWorkspaces: this.deps.getStore()?.getUI?.().hideBotCreatedWorkspaces !== false
    }
  }

  /** Each bot with what it is for, read from its SOUL.md now, so an edit shows at once. */
  async roster(): Promise<BotRosterEntry[]> {
    const soul = (bot: Bot) =>
      this.deps.filesystem.readText(join(botHomeFolder(bot, this.deps.botsRoot()), 'SOUL.md'))
    return Promise.all(
      this.list().map(async (bot) => ({
        ...botRosterFields(bot),
        specialty: soulSpecialty(await soul(bot))
      }))
    )
  }

  /** `origin`: made from a link (with its sharer's SOUL.md) or a built-in template; its first turn runs
   *  first-run rules like any new bot's. */
  create(input: BotCreateParams, origin?: BotOrigin): Promise<Bot> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const bot = await this.makeBot(store, input, origin)
      store.saveBot(bot)
      await persistBotStore(store)
      this.deps.notifyBotsWritten(true)
      return bot
    })
  }

  /** One bot per offer card, with any `install` (a template's package) in the same step; see bot-offer-creation. */
  readonly createFromOffer = botOfferCreation<BotStore, BotOrigin>({
    queue: (work) => this.serialize(() => work(requireBotStore(this.deps.getStore()))),
    makeBot: (store, input, origin) => this.makeBot(store, input, origin),
    saved: async (store) => {
      await persistBotStore(store)
      this.deps.notifyBotsWritten(true)
    }
  })

  /** The new bot with its home written, not yet saved; run inside the queue. */
  private async makeBot(
    store: BotStore,
    input: BotCreateParams,
    origin: BotOrigin = {}
  ): Promise<Bot> {
    const name = freeBotName(store.getBots(), input.name)
    const draft = { ...newBotRecord({ ...input, name }, Date.now()), ...origin }
    const bot: Bot = {
      ...draft,
      ...(await makeBotsHome(
        this.deps,
        store,
        templateBotFolderName(name, botTemplate(origin.templateId), input.templateNameShown),
        name,
        draft.agent,
        (path, folder) =>
          writeBotHome(
            this.deps.filesystem,
            path,
            { ...draft, folder, folderWorkspaceId: '' },
            input.seed ? proposalSoul(name, input.seed) : undefined
          )
      ))
    }
    const reply = input.importFrom?.reply?.trim()
    if (reply) {
      // The old bot's own words: read as data by the import, never sent as a turn.
      const home = botHomeFolder(bot, this.deps.botsRoot())
      await this.deps.filesystem.makeDirectory(join(home, 'import'))
      await this.deps.filesystem.writeText(join(home, BOT_IMPORT_REPLY_FILE), `${reply}\n`)
    }
    return bot
  }

  /** A hidden home for a bot group, made as a bot's is: `<bots root>/group-<slug>` in Bots. */
  createGroupHome(name: string, agent: Bot['agent']) {
    return this.serialize(() =>
      makeBotsHome(
        this.deps,
        requireBotStore(this.deps.getStore()),
        `group-${botFolderName(name)}`,
        name,
        agent
      )
    )
  }

  /** A function reads the bot as saved, inside the queue, so a concurrent edit is not lost. */
  update(botId: string, edit: BotHostUpdates | ((bot: Bot) => BotHostUpdates)): Promise<Bot> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const home = await readBotHomePicture(this.deps, requireStoredBot(store, botId))
      const updates = typeof edit === 'function' ? edit(home.bot) : edit
      const pictureChoice = [updates.avatar, updates.avatarColor, updates.avatarOutfit].some(
        (value) => value !== undefined
      )
      const bot =
        updates.avatar !== undefined
          ? botForManualPicture(this.deps, home, () => store.getFolderWorkspaces())
          : pictureChoice
            ? knownBotPicture(home)
            : home.bot
      if (updates.name !== undefined) {
        assertBotNameFree(store.getBots(), updates.name, botId)
      }
      const updated: Bot = { ...applyBotUpdates(bot, updates), updatedAt: Date.now() }
      // Any picture, color or outfit choice counts, even one that sets the same value again. Every other edit
      // keeps the highest revision seen, so rewriting bot.json from a record that lost it can't lower it.
      const revision = bot.avatarRevision ?? 0
      if (pictureChoice) {
        delete updated.generatedOverMascot
        updated.avatarRevision = revision + 1
      }
      const next = stampBotLinkOwners(bot, updated, () => this.deps.accountUserId?.() ?? null)
      if (home.known || pictureChoice) {
        await writeBotHome(this.deps.filesystem, botHomeFolder(next, this.deps.botsRoot()), next)
      }
      if (next.name !== bot.name) {
        store.updateFolderWorkspace(bot.folderWorkspaceId, { name: next.name })
      }
      store.saveBot(next)
      this.deps.notifyBotsWritten(next.name !== bot.name)
      if (next.agent !== bot.agent) {
        this.deps.botAgentChanged?.(next)
      }
      return next
    })
  }

  /** A square PNG of at least Slack's 512 px becomes the bot's picture, kept in its home. With
   *  `expectedAvatarRevision`, refused (bot_avatar_changed, nothing written) once any other picture,
   *  color or outfit write has landed since that revision. */
  setAvatarImage(
    botId: string,
    png: Uint8Array,
    expectedAvatarRevision?: number,
    expectedAvatarEpoch?: string
  ): Promise<Bot> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const bot = requireStoredBot(store, botId)
      const next = await writeBotAvatarImage(
        this.deps,
        bot,
        png,
        () => store.getFolderWorkspaces(),
        expectedAvatarRevision,
        expectedAvatarEpoch
      )
      store.saveBot(next)
      this.deps.notifyBotsWritten(false)
      return next
    })
  }

  /** The uploaded picture's PNG; null when the bot shows a mascot, an emoji or its initial. */
  async readAvatarImage(botId: string): Promise<Buffer | null> {
    const bot = requireStoredBot(requireBotStore(this.deps.getStore()), botId)
    if (!isUploadAvatar(bot.avatar)) {
      return null
    }
    return this.deps.filesystem.readBytes(
      join(botHomeFolder(bot, this.deps.botsRoot()), BOT_AVATAR_FILE)
    )
  }

  /** Not a user edit: the Chat module names which session is the bot's Chat. */
  setChatSession(botId: string, chatSessionId: string): Promise<Bot> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const bot = requireStoredBot(store, botId)
      const next: Bot = { ...bot, chatSessionId, updatedAt: Date.now() }
      store.saveBot(next)
      this.deps.notifyBotsWritten(false)
      return next
    })
  }

  /** Its owner's first turn in its Chat is handled, so first-run rules end; a no-op for a bot not in them. */
  endFirstRun(botId: string): Promise<void> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const bot = store.getBots().find((entry) => entry.id === botId)
      if (bot?.firstRun) {
        const { firstRun: _done, ...rest } = bot
        store.saveBot({ ...rest, updatedAt: Date.now() })
        this.deps.notifyBotsWritten(false)
      }
    })
  }

  delete({ botId, deleteFolder }: BotDeleteParams): Promise<{ deleted: boolean }> {
    return this.serialize(async () => {
      const store = requireBotStore(this.deps.getStore())
      const bot = requireStoredBot(store, botId)
      const folderPath = botHomeFolder(bot, this.deps.botsRoot())
      if (deleteFolder) {
        await assertBotOwnsHome(this.deps.filesystem, folderPath, botId)
      }
      // First, so none starts a run in a workspace being torn down; a failure leaves the bot to retry.
      await this.deps.deleteBotAutomations(botId)
      // Before its workspace goes, so its group turns freeze and a room it anchored moves.
      await this.deps.leaveBotGroups?.(botId)
      // Missing after a by-hand removal or an earlier failed delete; either way, go on.
      if (store.getFolderWorkspaces().some((entry) => entry.id === bot.folderWorkspaceId)) {
        // Stops the workspace's processes, which could otherwise hold the folder open.
        await this.deps.deleteFolderWorkspace(bot.folderWorkspaceId)
      }
      if (deleteFolder) {
        // Before the record goes, so a failed removal can be retried.
        await this.deps.filesystem.removeTree(folderPath)
      }
      store.removeBot(bot)
      await persistBotStore(store)
      this.deps.forgetBot?.(bot.id)
      this.deps.notifyBotsWritten(true)
      return { deleted: true }
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }
}
