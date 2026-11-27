import { feishuConnectionState } from './feishu-connection-state'
import { drainFeishuConnection } from './feishu-connection-delivery'
import { FeishuPeopleDirectory } from './feishu-people'
import { FeishuMessageIngress } from './feishu-message-ingress'
import { FeishuInteractions } from './feishu-interactions'
import { listProfiles } from './feishu-cli'
import { FeishuPairing } from './feishu-pairing'
import { setTimeout as delay } from 'node:timers/promises'
import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type { FeishuMessage } from './feishu-message'
import { feishuCliTransport } from './feishu-cli-transport'
import { feishuProblem, FeishuHostError } from './feishu-cli-status'
import { FeishuUploadPermissionError } from './feishu-transport'
import { openFeishuSdk } from './feishu-sdk'
import type { FeishuTransport } from './feishu-transport'
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
  private cardConsumer?: Promise<void>
  private readonly directory = new FeishuPeopleDirectory()
  private readonly ingress: FeishuMessageIngress
  private readonly interactions: FeishuInteractions
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly inbox: FeishuStore,
    private readonly scope: string,
    readonly binding: Binding
  ) {
    this.ingress = new FeishuMessageIngress(inbox, this.signal, () => {
      const bot = this.bot()
      return bot ? bot.members : []
    })
    this.interactions = new FeishuInteractions(
      runtime,
      inbox,
      binding,
      this.signal,
      () => !this.signal.aborted && Boolean(this.bot()),
      () => this.wake()
    )
  }

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
        : openFeishuSdk(this.binding.app, secret!, this.signal)
    this.consumer = this.listen(this.transport)
    if (this.binding.profile !== null) {
      this.cardConsumer = this.interactions.listen(() => this.checkProfile())
    }
    this.wake()
  }
  watch(): void {
    this.release?.()
    if (!this.signal.aborted && this.binding.owner) {
      this.release = this.runtime
        .getExternalConversationSeam()
        ?.watch(runtimeConversationHost(this.runtime), (event) => {
          if (this.binding.profile !== null) {
            this.interactions.event(event)
          }
          if (event.kind === 'turn-ended' && event.conversation.source === 'feishu-local') {
            this.wake()
          }
        })
    }
  }
  state(): Promise<FeishuLocalState> {
    return feishuConnectionState(
      this.binding,
      this.inbox,
      this.phase,
      this.deliveryRetry,
      Boolean(this.bot()),
      this.pairing
    )
  }
  async people(query: string) {
    if (this.binding.profile === null || !this.binding.owner) {
      throw new Error('Pair a local CLI connection before looking up members')
    }
    await this.checkProfile()
    return this.directory.search(this.binding.app, query, this.signal)
  }
  private async checkProfile(): Promise<void> {
    const profiles = await listProfiles(this.signal)
    if (!profiles.some((p) => p.appId === this.binding.app && p.name === this.binding.profile)) {
      throw new FeishuHostError('profile-changed')
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
    await Promise.allSettled([this.consumer, this.cardConsumer, this.work])
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
  private async receive(api: FeishuTransport, m: FeishuMessage): Promise<void> {
    if (!this.bot()) {
      return
    }
    const b = this.binding
    if (b.owner) {
      if (b.profile !== null) {
        await this.ingress.receive(b, m)
      } else if (b.owner === m.sender_id && b.chat === m.chat_id && m.chat_type === 'p2p') {
        await this.inbox.accept(b, m)
      } else {
        return
      }
      this.wake()
    } else if (m.message_type === 'text' && this.pairing?.matches(m.content)) {
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
      .then(async () => {
        if (
          this.binding.profile !== null &&
          (await this.inbox.deliveryRetrying(this.binding.account))
        ) {
          this.deliveryRetry = 'retrying'
          this.retryWork()
          this.changed()
        }
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
  private drain(api: FeishuTransport): Promise<void> {
    return drainFeishuConnection(
      {
        runtime: this.runtime,
        inbox: this.inbox,
        binding: this.binding,
        signal: this.signal,
        bot: () => this.bot(),
        checkProfile: () => this.checkProfile(),
        retryWork: () => this.retryWork(),
        changed: () => this.changed(),
        repeat: () => {
          this.again = true
        },
        ingress: this.ingress,
        interactions: this.interactions
      },
      api
    )
  }
}
