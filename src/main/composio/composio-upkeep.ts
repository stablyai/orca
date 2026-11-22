// The host's side of Composio events: the router for calls to the project's events hook, and the
// upkeep pass (deleted bots, triggers no automation listens for, the hook itself), at start, every
// half hour, and soon after automations change.
import type { Automation } from '../../shared/automations/automation-definition'
import type { WebhookCallRunsDeps } from '../webhooks/webhook-call-runs'
import { ComposioIngressStore, routeComposioCall } from './composio-events-ingress'

const UPKEEP_EVERY_MS = 30 * 60_000
// Long enough that one deletion's run of changes is one pass.
const UPKEEP_SOON_MS = 15_000

export function composioCallRouter(deps: {
  automations: () => readonly Automation[]
  /** An owner's sign-in expired at Composio: the bot's chat gets the Reconnect card. */
  expired: (accountId: string, app: string) => Promise<void>
  store?: ComposioIngressStore
}): NonNullable<WebhookCallRunsDeps['route']> {
  const store = deps.store ?? new ComposioIngressStore()
  return async (hookId, call) => {
    const ingress = store.byHook(hookId)
    if (!ingress) {
      return null
    }
    const route = routeComposioCall(deps.automations(), ingress, call)
    if (route.kind === 'automation') {
      return route
    }
    if (route.kind === 'expired') {
      // Awaited, so a failed lookup or chat write throws and the call is offered again later.
      await deps.expired(route.accountId, route.app)
      return { kind: 'handled', reason: 'composio_sign_in_expired' }
    }
    return { kind: 'handled', reason: 'not_for_any_bot' }
  }
}

export class ComposioUpkeep {
  private interval: ReturnType<typeof setInterval> | null = null
  private soonTimer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly label = 'composio'
  ) {}

  start(): void {
    void this.run()
    this.interval = setInterval(() => void this.run(), UPKEEP_EVERY_MS)
    this.interval.unref?.()
  }

  soon(): void {
    if (this.soonTimer) {
      clearTimeout(this.soonTimer)
    }
    this.soonTimer = setTimeout(() => void this.run(), UPKEEP_SOON_MS)
    this.soonTimer.unref?.()
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
    }
    if (this.soonTimer) {
      clearTimeout(this.soonTimer)
    }
  }

  /** One pass at a time; a failure waits for the next. */
  run(): Promise<void> {
    this.running ??= this.pass()
      .catch((error: unknown) => console.warn(`[${this.label}] upkeep pass failed`, error))
      .finally(() => {
        this.running = null
      })
    return this.running
  }
}
