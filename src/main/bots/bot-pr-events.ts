// Inert: a bot is no longer woken on its workers' pull requests; it makes a wait when it should follow
// one. connector-cloud-install.ts still builds this waker and takes pull
// request events with it, so they are accepted and dropped. Delete both with that file's cleanup.
import type { PrEvent } from '../../shared/connector-pr-event-contract'

export class BotPrWaker {
  constructor(_deps: unknown) {}

  /** Drops the event: nothing wakes a bot on it. */
  async handle(_deliveryId: string, _event: PrEvent): Promise<void> {}

  resume(): void {}
}
