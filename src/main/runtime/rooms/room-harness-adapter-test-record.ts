import { ROOM_HARNESS_AGENTS } from '../../../shared/rooms'
import type { RoomHarnessAdapter } from './harness-adapter-types'

export function roomHarnessAdapterTestRecord(
  overrides: Partial<RoomHarnessAdapter>
): Record<string, RoomHarnessAdapter> {
  return Object.fromEntries(
    ROOM_HARNESS_AGENTS.map((agent) => {
      return [agent, roomHarnessAdapterTestFixture({ agent, ...overrides })]
    })
  )
}

export function roomHarnessAdapterTestFixture(
  overrides: Partial<RoomHarnessAdapter>
): RoomHarnessAdapter {
  return {
    agent: 'codex',
    launch: unexpected,
    connectExisting: unexpected,
    locate: unexpected,
    read: unexpected,
    send: unexpected,
    interrupt: unexpected,
    stop: unexpected,
    restore: unexpected,
    reconfigure: unexpected,
    status: unexpected,
    incarnation: unexpected,
    awaitReady: unexpected,
    awaitInputReady: unexpected,
    context: unexpected,
    lastTranscriptActivityAt: unexpected,
    compact: unexpected,
    stageAttachment: unexpected,
    statusEvent: unexpected,
    subscribe: unexpected,
    ...overrides
  }
}

function unexpected(): never {
  throw new Error('Unexpected harness adapter call in test')
}
