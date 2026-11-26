import { FeishuPairing } from './feishu-pairing'
import { setTimeout as delay } from 'node:timers/promises'
import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { drainFeishuOutbox } from './feishu-outbox'
import type { FeishuInboundMessage, FeishuMessage } from './feishu-message'
import { feishuCliTransport } from './feishu-cli-transport'
import { feishuProblem } from './feishu-cli-status'
import { FeishuUploadPermissionError } from './feishu-transport'
import { openFeishuSdk } from './feishu-sdk'
import type { FeishuTransport } from './feishu-transport'
import { deliverFeishuInboxRow } from './feishu-delivery'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'

/** One grant lifetime. Replacing or revoking a grant aborts its pending process and admission. */
export class FeishuConnection {
  private readonly controller = new AbortController()
  private readonly signal = this.controller.signal
  private phase: FeishuLocalState['status'] = 'connecting'
  private pairing?: FeishuPairing
  private work: Promise<void> | undefined
  private transport?: Promise<FeishuTransport>
  private consumer: Promise<void> | undefined
  private release?: () => void
  private retry?: NodeJS.Timeout
  private again = false
  private deliveryRetry: 'retrying' | 'upload-permission' | null = null
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
  start(secret: string | null, pair: boolean): void {
    if (this.binding.profile === null && !secret) {
      this.setPhase('credentials-required')
      return
    }
    if (!pair && !this.binding.owner) {
      this.setPhase('expired')
      return
    }

    if (pair) {
      this.pairing = new FeishuPairing(() => {
        this.setPhase('expired')
        void this.stop()
      })
    }
    this.watch()
    this.transport =
      this.binding.profile !== null
        ? Promise.resolve(feishuCliTransport(this.binding.app, this.binding.profile, this.signal))
        : openFeishuSdk(this.binding.app, secret!, this.signal, this.binding.group)
    this.consumer = this.listen(this.transport)
    this.wake()
  }
  watch(): void {
    this.release?.()
    if (!this.signal.aborted && this.binding.owner) {
      this.release = this.runtime
        .getExternalConversationSeam()
        ?.watch(runtimeConversationHost(this.runtime), (event) => {
          if (
            event.kind === 'turn-ended' &&
            (event.conversation.source === 'feishu-local' ||
              event.conversation.source === 'feishu-group')
          ) {
            this.wake()
          }
        })
    }
  }
  async state(): Promise<FeishuLocalState> {
    const { account } = this.binding
    const status =
      this.phase === 'credentials-required'
        ? this.phase
        : (await this.inbox.needsReview(account))
          ? 'review'
          : !this.bot()
            ? 'paused'
            : this.deliveryRetry && this.phase === 'listening'
              ? this.deliveryRetry
              : this.phase
    return {
      method: this.binding.profile === null ? 'sdk' : 'cli',
      ...(this.binding.profile === null ? {} : { profile: this.binding.profile }),
      appId: this.binding.app,
      ...(this.binding.group ? { groupChatId: this.binding.group.chatId } : {}),
      status,
      ...((status === 'pairing' || status === 'verification-failed') && this.pairing
        ? { pairingText: this.pairing.text }
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
    this.pairing?.close()
    this.pairing = undefined
    this.release?.()
    clearTimeout(this.retry)
    await Promise.allSettled([this.consumer, this.work])
  }
  private async listen(transport: Promise<FeishuTransport>): Promise<void> {
    let backoff = 1000
    while (!this.signal.aborted) {
      let problem: FeishuLocalState['status'] = 'retrying'
      try {
        const api = await transport
        this.setPhase('connecting')
        await api.listen(
          () => {
            if (this.signal.aborted) {
              return
            }
            this.setPhase(this.binding.owner ? 'listening' : 'pairing')
            backoff = 1000
            this.wake()
          },
          () => {
            if (!this.signal.aborted) {
              this.setPhase('retrying')
            }
          },
          (message) => this.receive(api, message)
        )
      } catch (error) {
        if (this.binding.profile !== null) {
          problem = feishuProblem(error)
        }
      }
      if (this.signal.aborted) {
        break
      }
      this.setPhase(problem)
      await delay(backoff, undefined, { signal: this.signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  private async receive(api: FeishuTransport, m: FeishuInboundMessage): Promise<void> {
    if (!this.bot()) {
      return
    }
    const b = this.binding
    if (b.owner) {
      if (await this.inbox.accept(b, m)) {
        this.wake()
      }
    } else if (
      m.chat_type === 'p2p' &&
      m.message_type === 'text' &&
      this.pairing?.matches(m.content)
    ) {
      await this.confirm(api, m, this.pairing)
    }
  }
  private async confirm(
    api: FeishuTransport,
    m: FeishuMessage,
    challenge: FeishuPairing
  ): Promise<void> {
    const result = await challenge.verify(
      api,
      m,
      () => !this.signal.aborted && !this.binding.owner && Boolean(this.bot()),
      () => this.inbox.pair(this.scope, this.binding, m)
    )
    if (this.signal.aborted) {
      return
    }
    if (result === 'rejected') {
      this.setPhase('verification-failed')
    }
    if (result === 'paired') {
      this.pairing = undefined
      this.binding.owner = m.sender_id
      this.binding.chat = m.chat_id
      this.binding.pairedAt = Number(m.create_time)
      this.setPhase('listening')
      this.watch()
      this.wake()
    }
  }
  wake(): void {
    if (
      this.signal.aborted ||
      !this.transport ||
      !this.binding.owner ||
      !this.bot() ||
      this.retry
    ) {
      return
    }
    if (this.work) {
      this.again = true
      return
    }
    this.work = this.transport
      .then((api) => this.drain(api))
      .then(() => {
        if (this.deliveryRetry && !this.retry) {
          this.deliveryRetry = null
          this.changed()
        }
      })
      .catch((error: unknown) => {
        const reason =
          error instanceof FeishuUploadPermissionError ? 'upload-permission' : 'retrying'
        if (reason !== this.deliveryRetry) {
          this.deliveryRetry = reason
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
  private async drain(api: FeishuTransport): Promise<void> {
    const b = this.binding
    let row = await this.inbox.next(b.account)
    for (let count = 0; row && !this.signal.aborted && count < 32; count++) {
      const bot = this.bot()
      if (!bot) {
        return
      }
      const delivery = await deliverFeishuInboxRow(
        this.runtime,
        api,
        this.inbox,
        b,
        row,
        bot.agent,
        this.signal,
        () => Boolean(this.bot())
      )
      if (!delivery || this.signal.aborted) {
        return
      }
      if (delivery === 'backlog') {
        this.retryWork()
        break
      }
      if (delivery === 'review') {
        this.changed()
      }
      row = await this.inbox.next(b.account)
    }
    if (row && !this.retry && !this.signal.aborted) {
      this.again = true
    }
    const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
    if (!journal) {
      await this.runtime.ensureStructuredAgentSessionHost()
      this.retryWork()
      return
    }
    await drainFeishuOutbox(
      api,
      journal,
      this.inbox,
      this.binding,
      this.signal,
      () => !this.signal.aborted && Boolean(this.bot()),
      () => this.changed()
    )
    if (b.group && (await this.inbox.next(b.account))) {
      this.again = true
    }
  }
}
