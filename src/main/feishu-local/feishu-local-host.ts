import { access, open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import type { Binding } from './feishu-binding'
import { feishuStore, type FeishuStore } from './feishu-store-ops'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { listProfiles } from './feishu-cli'
import { FeishuConnection } from './feishu-connection'

export class FeishuLocalHost {
  private readonly inbox: FeishuStore
  private readonly active = new Map<string, FeishuConnection>()
  private readonly opening: Promise<void>
  private stopping = false
  private restoreFailed = false
  private readonly file: string
  private readonly scope: string
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
      if (this.runtime.bots.list().some((bot) => bot.id === b.bot)) {
        this.launch(b, false)
      } else {
        await this.inbox.remove(this.scope, b.bot, b.account)
      }
    }
  }
  private launch(b: Binding, pair: boolean): void {
    const c = new FeishuConnection(this.runtime, this.inbox, this.scope, b)
    this.active.set(b.bot, c)
    c.start(pair)
  }
  async state(bot: string): Promise<FeishuLocalState> {
    await this.opening
    if (this.restoreFailed) {
      throw new Error('Could not read Feishu bindings')
    }
    return this.active.get(bot)?.state() ?? { status: 'off' }
  }
  async profiles(): Promise<string[]> {
    return (await listProfiles()).map((p) => p.name)
  }
  async connect(bot: string, profile: string): Promise<void> {
    await this.opening
    const p = (await listProfiles()).find((entry) => entry.name === profile)
    if (
      !p ||
      this.restoreFailed ||
      this.stopping ||
      !this.runtime.bots.enabled() ||
      !this.runtime.bots.list().some((b) => b.id === bot && !b.paused)
    ) {
      throw new Error('The bot or Feishu profile is unavailable')
    }
    let b: Binding
    try {
      // Protect the inbox before SQLite opens it or creates its journal.
      await (await open(this.file, 'a', 0o600)).close()
      b = await this.inbox.add(this.scope, bot, p)
    } catch {
      throw new Error('Could not reserve this Feishu app for this bot')
    }
    if (this.stopping || !this.runtime.bots.list().some((entry) => entry.id === bot)) {
      await this.inbox.remove(this.scope, bot, b.account)
      throw new Error('The bot is unavailable')
    }
    this.launch(b, true)
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
        if (this.active.get(bot) === c) {
          this.active.delete(bot)
        }
        this.runtime.notifyBotsChanged({ botIds: [bot], kinds: ['settings'] })
      })
      .finally(() => this.retiring.delete(bot))
    this.retiring.set(bot, removal)
    return removal
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
        .concat([...this.retiring.values()], this.opening)
    )
    this.active.clear()
  }
}
