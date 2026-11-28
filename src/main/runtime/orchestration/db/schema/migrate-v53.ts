import type { OrchestrationDb } from '../orchestration-db'
import { readSettledRequestMailBackfill } from '../messages/settled-request-mail'

/** Requests whose outcome was recorded while their mail stayed unread are read, so none replays. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  readSettledRequestMailBackfill(this)
}
