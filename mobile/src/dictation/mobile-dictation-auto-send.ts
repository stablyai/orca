import type { MobileSpeechSetup } from './mobile-dictation-setup'
import {
  DEFAULT_DICTATION_AUTO_SEND_DELAY_MS,
  dictationAutoSendDelayMs
} from '../../../src/shared/dictation-auto-send'

// Null when the setting is off or the computer predates it.
export function mobileDictationAutoSendDelayMs(
  setup: Pick<MobileSpeechSetup, 'autoSendAfterDictation' | 'autoSendDelayMs'>
): number | null {
  if (setup.autoSendAfterDictation !== true) {
    return null
  }
  return dictationAutoSendDelayMs({
    autoSendDelayMs: setup.autoSendDelayMs ?? DEFAULT_DICTATION_AUTO_SEND_DELAY_MS
  })
}

export type MobileDictationAutoSendCountdown = {
  readonly scope: string
  readonly conversation: string
  readonly deadline: number
  readonly delayMs: number
}

// One dictation, at most one send.
export class MobileDictationAutoSend {
  private armed: {
    readonly scope: string
    readonly delayMs: number
    readonly conversation: string
  } | null = null
  private countdown: MobileDictationAutoSendCountdown | null = null
  private conversation: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly senders = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()

  arm(chatScope: string | null, delayMs: number | null): void {
    this.withdraw()
    const conversation = this.conversation
    this.armed =
      chatScope !== null && delayMs !== null && conversation !== null
        ? { scope: chatScope, delayMs, conversation }
        : null
  }

  // A replaced agent session or terminal is another conversation, so a send armed for the old one never lands there.
  sendsTo(conversation: string): void {
    this.conversation = conversation
    const pending = this.countdown ?? this.armed
    if (pending && pending.conversation !== conversation) {
      this.withdraw()
    }
  }

  readonly withdraw = (): void => {
    this.armed = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.publish(null)
  }

  start({ partial }: { partial: boolean }): MobileDictationAutoSendCountdown | null {
    const armed = this.armed
    this.armed = null
    // A failure that hands over the words heard so far leaves them a draft.
    if (partial || !armed || !this.senders.has(armed.scope)) {
      return null
    }
    const countdown = {
      scope: armed.scope,
      conversation: armed.conversation,
      deadline: Date.now() + armed.delayMs,
      delayMs: armed.delayMs
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.publish(null)
      this.senders.get(armed.scope)?.()
    }, armed.delayMs)
    this.publish(countdown)
    return countdown
  }

  register(scope: string, send: () => void): () => void {
    this.senders.set(scope, send)
    return () => {
      // A newer composer for this chat replaced this one, and the send is now its to make.
      if (this.senders.get(scope) !== send) {
        return
      }
      this.senders.delete(scope)
      if (this.armed?.scope === scope || this.countdown?.scope === scope) {
        this.withdraw()
      }
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): MobileDictationAutoSendCountdown | null => this.countdown

  private publish(next: MobileDictationAutoSendCountdown | null): void {
    if (this.countdown === next) {
      return
    }
    this.countdown = next
    for (const listener of this.listeners) {
      listener()
    }
  }
}
