import { measureUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'

export const MOBILE_SCHEDULED_NOTIFICATION_MAX_ENTRIES = 256
export const MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES = 2 * 1024 * 1024
export const MOBILE_NATIVE_NOTIFICATION_ID_MAX_BYTES = 8 * 1024

export type MobileScheduledNotificationState = {
  identifier?: string
  pending?: Promise<string | null>
  dismissAfterSchedule?: boolean
  retainedKeyBytes: number
  retainedIdentifierBytes: number
  retained: boolean
}

export type MobileScheduledNotificationReservation = {
  state: MobileScheduledNotificationState
  evictedIdentifiers: string[]
}

function retainedStringBytes(value: string): number {
  return 64 + value.length * 2
}

export class MobileScheduledNotificationRegistry {
  private readonly entries = new Map<string, MobileScheduledNotificationState>()
  private retainedBytes = 0
  private maxEntries = MOBILE_SCHEDULED_NOTIFICATION_MAX_ENTRIES

  get(key: string): MobileScheduledNotificationState | undefined {
    return this.entries.get(key)
  }

  reserve(key: string): MobileScheduledNotificationReservation | null {
    const retainedKeyBytes = retainedStringBytes(key)
    if (retainedKeyBytes > MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES) {
      return null
    }
    const evictedIdentifiers: string[] = []
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + retainedKeyBytes > MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES
    ) {
      const settled = this.findOldestSettled()
      if (!settled) {
        return null
      }
      this.delete(settled[0])
      if (settled[1].identifier) {
        evictedIdentifiers.push(settled[1].identifier)
      }
    }
    const state: MobileScheduledNotificationState = {
      retainedKeyBytes,
      retainedIdentifierBytes: 0,
      retained: true
    }
    this.entries.set(key, state)
    this.retainedBytes += retainedKeyBytes
    return { state, evictedIdentifiers }
  }

  delete(key: string): boolean {
    const state = this.entries.get(key)
    if (!state) {
      return false
    }
    this.entries.delete(key)
    this.retainedBytes -= state.retainedKeyBytes + state.retainedIdentifierBytes
    state.retained = false
    return true
  }

  clearIdentifier(state: MobileScheduledNotificationState): void {
    if (!state.identifier) {
      return
    }
    if (state.retained) {
      this.retainedBytes -= state.retainedIdentifierBytes
    }
    state.identifier = undefined
    state.retainedIdentifierBytes = 0
  }

  retainIdentifier(state: MobileScheduledNotificationState, identifier: string): boolean {
    const measurement = measureUtf8ByteLength(identifier, {
      stopAfterBytes: MOBILE_NATIVE_NOTIFICATION_ID_MAX_BYTES
    })
    if (measurement.exceededLimit || !state.retained) {
      return false
    }
    const identifierBytes = retainedStringBytes(identifier)
    if (
      this.retainedBytes - state.retainedIdentifierBytes + identifierBytes >
      MOBILE_SCHEDULED_NOTIFICATION_MAX_RETAINED_BYTES
    ) {
      return false
    }
    this.clearIdentifier(state)
    state.identifier = identifier
    state.retainedIdentifierBytes = identifierBytes
    this.retainedBytes += identifierBytes
    return true
  }

  resetForTests(maxEntries?: number): void {
    for (const state of this.entries.values()) {
      state.retained = false
    }
    this.entries.clear()
    this.retainedBytes = 0
    this.maxEntries = maxEntries ?? MOBILE_SCHEDULED_NOTIFICATION_MAX_ENTRIES
  }

  getRetainedBytesForTests(): number {
    return this.retainedBytes
  }

  private findOldestSettled(): [string, MobileScheduledNotificationState] | null {
    for (const entry of this.entries) {
      if (!entry[1].pending) {
        return entry
      }
    }
    return null
  }
}
