import { ROOM_HARNESS_AGENTS } from '../../../shared/rooms'
import type { RoomHarnessAdapter } from './harness-adapter-types'

export function roomHarnessAdapterTestRecord(
  overrides: Partial<RoomHarnessAdapter>
): Record<string, RoomHarnessAdapter> {
  return Object.fromEntries(
    ROOM_HARNESS_AGENTS.map((agent) => [agent, { agent, ...overrides } as RoomHarnessAdapter])
  )
}
