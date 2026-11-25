import { feishuProblem, FeishuHostError, type FeishuProblem } from './feishu-cli-status'
import { acknowledgeFeishuMessage } from './feishu-replies'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { drainFeishuOutbox } from './feishu-outbox'
import { consumeFeishu, humanSentPairing, listProfiles, type FeishuMessage } from './feishu-cli'
import { feishuInput } from './feishu-resources'
import { dmKey, type Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'

/** One grant lifetime. Replacing or revoking a grant aborts its pending process and admission. */
export class FeishuConnection {
  private readonly controller = new AbortController()
  private readonly signal = this.controller.signal
  private phase: FeishuLocalState['status'] = 'connecting'
  private code: string | undefined
  private expires = 0
  private work: Promise<void> | undefined
  private consumer: Promise<void> | undefined
  private release?: () => void
  private tick?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private again = false
  private deliveryRetry = false
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly inbox: FeishuStore,
    private readonly scope: string,
    readonly binding: Binding
  ) {}

  private changed(): void {
    this.runtime.notifyBotsChanged({ botIds: [this.binding.bot], kinds: ['settings'] })
  }
  private setPhase(phase: FeishuLocalState['status']): void {
    if (phase !== this.phase) {
      this.phase = phase
      this.changed()
    }
  }
  start(pair: boolean): void {
    if (pair) {
      this.code = `Orca ${randomBytes(16).toString('hex')}`
      this.expires = Date.now() + 5 * 60_000
    }
    if (!this.binding.owner && !this.code) {
      this.setPhase('expired')
      return
    }
    this.watch()
    if (pair) {
      this.tick = setTimeout(() => {
        if (this.code) {
          this.setPhase('expired')
          void this.stop()
        }
      }, 5 * 60_000).unref()
    }
    this.consumer = this.listen()
    this.wake()
  }
  watch(): void {
    this.release?.()
    if (!this.signal.aborted && this.binding.owner) {
      this.release = this.runtime
        .getExternalConversationSeam()
        ?.watch(runtimeConversationHost(this.runtime), (event) => {
          if (event.kind === 'turn-ended' && event.conversation.source === 'feishu-local') {
            this.wake()
          }
        })
    }
  }
  async state(): Promise<FeishuLocalState> {
    const { account, profile } = this.binding
    const status = (await this.inbox.needsReview(account))
      ? 'review'
      : !this.bot()
        ? 'paused'
        : this.deliveryRetry && this.phase === 'listening'
          ? 'retrying'
          : this.phase
    return {
      profile,
      appId: this.binding.app,
      status,
      ...((status === 'pairing' || status === 'verification-failed') && this.code
        ? { pairingText: this.code }
        : {})
    }
  }
  private bot() {
    return (
      this.runtime.bots.enabled() &&
      this.runtime.bots.list().find((b) => b.id === this.binding.bot && !b.paused)
    )
  }
  async stop(): Promise<void> {
    this.controller.abort()
    this.code = undefined
    this.release?.()
    clearTimeout(this.tick)
    clearTimeout(this.retry)
    await Promise.allSettled([this.consumer, this.work])
  }
  private async checkProfile(): Promise<void> {
    const profiles = await listProfiles(this.signal)
    if (!profiles.some((p) => p.appId === this.binding.app && p.name === this.binding.profile)) {
      throw new FeishuHostError('profile-changed')
    }
  }
  private async listen(): Promise<void> {
    let backoff = 1000
    while (!this.signal.aborted) {
      let problem: FeishuProblem = 'retrying'
      try {
        await this.checkProfile()
        this.setPhase('connecting')
        await consumeFeishu(
          this.binding.app,
          this.signal,
          () => {
            this.setPhase(this.binding.owner ? 'listening' : 'pairing')
            backoff = 1000
          },
          (m) => this.receive(m)
        )
      } catch (error) {
        problem = feishuProblem(error)
      }
      if (this.signal.aborted) {
        break
      }
      this.setPhase(problem)
      await delay(backoff, undefined, { signal: this.signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  private async receive(m: FeishuMessage): Promise<void> {
    if (!this.bot()) {
      return
    }
    const b = this.binding
    if (b.owner) {
      if (b.owner !== m.sender_id || b.chat !== m.chat_id) {
        return
      }
      await this.inbox.accept(b, m)
      this.wake()
    } else if (
      m.message_type === 'text' &&
      this.code &&
      m.content === this.code &&
      Date.now() < this.expires
    ) {
      try {
        await this.confirm(m)
      } catch {
        if (!this.signal.aborted) {
          this.setPhase('verification-failed')
        }
      }
    }
  }
  private async confirm(m: FeishuMessage): Promise<void> {
    if (
      !(await humanSentPairing(this.binding.app, m, this.signal)) ||
      this.signal.aborted ||
      !this.bot() ||
      Date.now() >= this.expires
    ) {
      return
    }
    if ((await this.inbox.pair(this.scope, this.binding, m)) && !this.signal.aborted) {
      this.code = undefined
      clearTimeout(this.tick)
      this.binding.owner = m.sender_id
      this.binding.chat = m.chat_id
      this.binding.pairedAt = Number(m.create_time)
      this.setPhase('listening')
      this.watch()
      this.wake()
    }
  }
  wake(): void {
    if (this.signal.aborted || !this.binding.owner || !this.bot() || this.retry) {
      return
    }
    if (this.work) {
      this.again = true
      return
    }
    this.work = this.drain()
      .then(() => {
        if (this.deliveryRetry && !this.retry) {
          this.deliveryRetry = false
          this.changed()
        }
      })
      .catch(() => {
        if (!this.deliveryRetry) {
          this.deliveryRetry = true
          this.changed()
        }
        this.retryWork()
      })
      .finally(() => {
        this.work = undefined
        if (this.again) {
          this.again = false
          this.wake()
        }
      })
  }
  private retryWork(): void {
    if (this.signal.aborted || this.retry) {
      return
    }
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.wake()
    }, 15_000).unref()
  }
  private async drain(): Promise<void> {
    const b = this.binding
    const seam = this.runtime.getExternalConversationSeam()
    if (!b.owner || !b.chat || !seam || !this.bot()) {
      return
    }
    const host = runtimeConversationHost(this.runtime)
    const key = dmKey(b)
    let row = await this.inbox.next(b.account)
    while (row && !this.signal.aborted) {
      if (row.kind !== 'text') {
        await this.checkProfile()
      }
      const bot = this.bot()
      if (!bot) {
        return
      }
      const { prompt, storedImages } = await feishuInput(this.inbox, b, row, bot.agent, this.signal)
      const { initial } = await seam.start(host, key, row.mid, {
        agent: bot.agent,
        transportSignal: this.signal,
        target: { kind: 'bot', botId: bot.id },
        prompt,
        note: 'If the owner asks you to create a small file, pipe its generated bytes into `orca bot reply --file-stdin <filename>` in this turn. The host attaches it to this DM. Never send an unrelated local file.',
        storedImages,
        asker: {
          userId: b.owner,
          role: 'owner',
          place: { kind: 'direct_message', id: b.chat },
          text: prompt,
          context: []
        },
        reply: { account: b.account }
      })
      if (this.signal.aborted) {
        return
      }
      if (initial.outcome === 'refused' && initial.reason === 'delivery_backlog_full') {
        this.retryWork()
        break
      }
      if (initial.outcome === 'accepted') {
        await acknowledgeFeishuMessage(this.inbox, b, row.mid, this.signal, () =>
          Boolean(this.bot())
        )
      } else {
        await this.inbox.review(b.account, row.mid)
        this.changed()
      }
      await this.inbox.admitted(b.account, row.mid)
      row = await this.inbox.next(b.account)
    }
    await this.sendOwed()
  }
  private async sendOwed(): Promise<void> {
    const b = this.binding
    if (!b.chat) {
      return
    }
    const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
    if (!journal) {
      await this.runtime.ensureStructuredAgentSessionHost()
      this.retryWork()
      return
    }
    await drainFeishuOutbox(
      journal,
      this.inbox,
      b,
      this.signal,
      () => !this.signal.aborted && Boolean(this.bot()),
      () => this.checkProfile(),
      () => this.changed()
    )
  }
}
