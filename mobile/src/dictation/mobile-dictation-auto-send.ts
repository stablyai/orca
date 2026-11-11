import type { MobileSpeechSetup } from './mobile-dictation-setup'

// The desktop's DICTATION_AUTO_SEND_DELAYS_MS; its module (src/shared/constants) would pull every settings default into the phone.
const AUTO_SEND_DELAYS_MS = [1000, 2000, 3000, 5000]
const DEFAULT_AUTO_SEND_DELAY_MS = 2000

/** The computer's "Send when dictation ends" delay; null when it is off or the computer predates it. */
export function mobileDictationAutoSendDelayMs(
  setup: Pick<MobileSpeechSetup, 'autoSendAfterDictation' | 'autoSendDelayMs'>
): number | null {
  if (setup.autoSendAfterDictation !== true) {
    return null
  }
  return (
    AUTO_SEND_DELAYS_MS.find((delayMs) => delayMs === setup.autoSendDelayMs) ??
    DEFAULT_AUTO_SEND_DELAY_MS
  )
}

export type MobileDictationAutoSendCountdown = {
  readonly scope: string
  readonly deadline: number
  readonly delayMs: number
}

// One dictation, at most one send: armed when a chat dictation starts, counted down only once its own words land whole.
export class MobileDictationAutoSend {
  private armed: { readonly scope: string; readonly delayMs: number } | null = null
  private countdown: MobileDictationAutoSendCountdown | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly senders = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()

  /** A dictation started: any earlier one's send is withdrawn, and this one may send if it goes into a chat's draft with the setting on. */
  arm(chatScope: string | null, delayMs: number | null): void {
    this.withdraw()
    this.armed = chatScope !== null && delayMs !== null ? { scope: chatScope, delayMs } : null
  }

  /** The user took over or moved away: the draft stays and nothing sends. */
  readonly withdraw = (): void => {
    this.armed = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.publish(null)
  }

  /** The armed dictation's words landed; a failure's words so far stay a draft. Null when nothing counts down. */
  start({ partial }: { partial: boolean }): MobileDictationAutoSendCountdown | null {
    const armed = this.armed
    this.armed = null
    if (partial || !armed || !this.senders.has(armed.scope)) {
      return null
    }
    const countdown = {
      scope: armed.scope,
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

  /** A chat composer whose Send may run on its own; going away withdraws its chat's send. */
  register(scope: string, send: () => void): () => void {
    this.senders.set(scope, send)
    return () => {
      if (this.senders.get(scope) === send) {
        this.senders.delete(scope)
      }
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
