import { feishuAsker } from '../../shared/bots/feishu-members'
import { access, open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { FeishuLocalState, FeishuSetup } from '../../shared/bots/feishu-local'
import { dmKey, type Binding } from './feishu-binding'
import { feishuStore, type FeishuStore } from './feishu-store-ops'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { listProfiles } from './feishu-cli'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { FeishuConnection } from './feishu-connection'

export class FeishuLocalHost {
  private readonly inbox: FeishuStore
  private readonly active = new Map<string, FeishuConnection>()
  private readonly opening: Promise<void>
  private stopping = false
  private restoreFailed = false
  private readonly file: string
  private readonly scope: string
  private readonly connecting = new Set<Promise<void>>()
  private readonly failedRemovals = new Set<string>()
  private readonly retiring = new Map<string, Promise<void>>()
  private readonly unwatch: () => void
  constructor(
    private readonly runtime: OrcaRuntimeService,
    root: string,
    profile: string
  ) {
    this.file = join(root, 'feishu-local.sqlite')
    this.scope = relative(root, profile).split(sep).join('/')
    this.inbox = feishuStore(runtime.botsDb, this.file)
    this.opening = this.restore().catch(() => {
      this.restoreFailed = true
    })
    this.unwatch = runtime.onBotsWritten(() => {
      for (const [bot, connection] of this.active) {
        if (!runtime.bots.list().some((b) => b.id === bot)) {
          void this.remove(bot).catch(() =>
            console.warn('[feishu] Could not remove the deleted bot’s binding')
          )
        } else {
          connection.wake()
        }
      }
    })
  }
  private async restore(): Promise<void> {
    try {
      await access(this.file)
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'ENOENT') {
        return
      }
      throw error
    }
    if (this.stopping) {
      return
    }
    for (const b of await this.inbox.bindings(this.scope)) {
      if (this.stopping) {
        return
      }
      let secret: string | null = null
      if (b.profile === null) {
        const sealed = await this.inbox.credential(b.account)
        try {
          if (sealed) {
            secret = getSecretStore().decryptString(Buffer.from(sealed, 'base64'))
          }
        } catch {
          /* Leave an unreadable credential disconnected. */
        }
      }
      if (this.stopping) {
        return
      }
      if (this.runtime.bots.list().some((bot) => bot.id === b.bot)) {
        this.launch(b, secret, false)
      } else {
        await this.inbox.remove(this.scope, b.bot, b.account)
      }
    }
  }
  private launch(b: Binding, secret: string | null, pair: boolean): void {
    const c = new FeishuConnection(this.runtime, this.inbox, this.scope, b)
    this.active.set(b.bot, c)
    c.start(secret, pair)
  }
  async state(bot: string): Promise<FeishuLocalState> {
    await this.opening
    if (this.restoreFailed) {
      throw new Error('Could not read Feishu bindings')
    }
    if (this.failedRemovals.has(bot)) {
      return { status: 'disconnect-failed' }
    }
    return this.active.get(bot)?.state() ?? { status: 'off' }
  }
  async members(botId: string, query: string) {
    await this.opening
    const connection = this.active.get(botId)
    if (!connection || this.stopping || this.retiring.has(botId)) {
      throw new Error('Feishu is not connected')
    }
    return connection.people(query)
  }
  async profiles(): Promise<string[]> {
    return (await listProfiles()).map((p) => p.name)
  }
  async connect(bot: string, setup: FeishuSetup): Promise<void> {
    const pending = this.connectBot(bot, setup)
    this.connecting.add(pending)
    try {
      await pending
    } finally {
      this.connecting.delete(pending)
    }
  }
  private async connectBot(bot: string, setup: FeishuSetup): Promise<void> {
    await this.opening
    if (
      this.restoreFailed ||
      this.stopping ||
      this.retiring.has(bot) ||
      this.active.has(bot) ||
      !this.runtime.bots.enabled() ||
      !this.runtime.bots.list().some((b) => b.id === bot && !b.paused)
    ) {
      throw new Error('The bot is unavailable or already connected')
    }
    let reservation: Parameters<FeishuStore['add']>[2]
    if ('profile' in setup) {
      const profile = (await listProfiles()).find((p) => p.name === setup.profile)
      if (!profile) {
        throw new Error('The Feishu profile is unavailable')
      }
      reservation = profile
    } else {
      const store = getSecretStore()
      const sealing = store.describeSealing?.()
      if (!sealing || sealing.kind === 'none' || !store.isEncryptionAvailable()) {
        throw new Error('Protected credential storage is unavailable on this host')
      }
      const encrypted = await (store.encryptStringAsync?.(setup.appSecret) ??
        store.encryptString(setup.appSecret))
      reservation = { appId: setup.appId, sealedSecret: encrypted.toString('base64') }
    }
    let binding: Binding
    try {
      await (await open(this.file, 'a', 0o600)).close()
      binding = await this.inbox.add(this.scope, bot, reservation)
    } catch {
      throw new Error('Could not reserve this Feishu app for this bot')
    }
    if (this.stopping || !this.runtime.bots.list().some((b) => b.id === bot && !b.paused)) {
      await this.inbox.remove(this.scope, bot, binding.account)
      throw new Error('The bot is unavailable')
    }
    this.launch(binding, 'appSecret' in setup ? setup.appSecret : null, true)
    this.runtime.notifyBotsChanged({ botIds: [bot], kinds: ['settings'] })
  }
  async remove(bot: string): Promise<void> {
    await this.opening
    const c = this.active.get(bot)
    if (!c || this.stopping) {
      return
    }
    const pending = this.retiring.get(bot)
    if (pending) {
      return pending
    }
    const removal = c
      .stop()
      .then(async () => {
        await this.inbox.remove(this.scope, bot, c.binding.account)
        this.failedRemovals.delete(bot)
        if (this.active.get(bot) === c) {
          this.active.delete(bot)
        }
        this.runtime.notifyBotsChanged({ botIds: [bot], kinds: ['settings'] })
      })
      .catch((error: unknown) => {
        this.failedRemovals.add(bot)
        this.runtime.notifyBotsChanged({ botIds: [bot], kinds: ['settings'] })
        throw error
      })
      .finally(() => this.retiring.delete(bot))
    this.retiring.set(bot, removal)
    return removal
  }
  async isGroupThread(botId: string, external: string): Promise<boolean> {
    const c = this.active.get(botId)
    return Boolean(c && (await this.inbox.laneRoute(c.binding.account, external))?.group)
  }
  private async mayReply(b: Binding, external: string, mid: string): Promise<boolean> {
    const route = await this.inbox.messageRoute(b.account, mid)
    if (route ? route.external !== external : dmKey(b).externalId !== external) {
      return false
    }
    const sender = await this.inbox.sender(b.account, mid)
    const bot = this.runtime.bots.list().find((entry) => entry.id === b.bot && !entry.paused)
    return Boolean(bot && feishuAsker(b, bot.members, sender))
  }
  async stageFile(
    botId: string,
    externalId: string,
    mid: string,
    name: string,
    bytes: Buffer
  ): Promise<void> {
    const c = this.active.get(botId)
    if (
      this.stopping ||
      this.retiring.has(botId) ||
      this.failedRemovals.has(botId) ||
      !c ||
      !c.binding.owner ||
      (dmKey(c.binding).externalId !== externalId &&
        !(await this.inbox.laneRoute(c.binding.account, externalId))) ||
      !this.runtime.bots.enabled() ||
      !this.runtime.bots.list().some((b) => b.id === botId && !b.paused)
    ) {
      throw new Error('This Feishu conversation cannot receive files')
    }
    if (!(await this.mayReply(c.binding, externalId, mid))) {
      throw new Error('not_this_bots_conversation')
    }
    await this.inbox.stageFile(c.binding.account, mid, name, bytes)
  }
  async reply(
    botId: string,
    externalId: string,
    mid: string,
    replyId: string,
    text: string,
    choices?: string[]
  ) {
    const c = this.active.get(botId)
    if (
      this.stopping ||
      this.retiring.has(botId) ||
      !c?.binding.owner ||
      (dmKey(c.binding).externalId !== externalId &&
        !(await this.inbox.laneRoute(c.binding.account, externalId))) ||
      !this.runtime.bots.enabled() ||
      !this.runtime.bots.list().some((b) => b.id === botId && !b.paused)
    ) {
      throw new Error('not_this_bots_conversation')
    }
    if (!(await this.mayReply(c.binding, externalId, mid))) {
      throw new Error('not_this_bots_conversation')
    }
    if (choices?.length) {
      const route = await this.inbox.messageRoute(c.binding.account, mid)
      await this.inbox.putCard(
        c.binding.account,
        `choices:${replyId}`,
        externalId,
        mid,
        route?.chat ?? c.binding.chat!,
        {
          kind: 'choices',
          inline: true,
          text,
          options: choices.map((label, i) => ({ id: String(i), label }))
        }
      )
      c.wake()
      return { status: 'queued' as const }
    }
    const result = await this.inbox.queueReply(c.binding.account, mid, replyId, text)
    c.wake()
    return result
  }
  repliesFilled(): void {
    for (const c of this.active.values()) {
      c.wake()
    }
  }
  rewatch(): void {
    if (this.stopping) {
      return
    }
    for (const c of this.active.values()) {
      c.watch()
    }
  }
  async stop(): Promise<void> {
    if (this.stopping) {
      return
    }
    this.stopping = true
    this.unwatch()
    await Promise.allSettled(
      [...this.active.values()]
        .map((c) => c.stop())
        .concat([...this.retiring.values()], [...this.connecting], this.opening)
    )
    this.active.clear()
  }
}
