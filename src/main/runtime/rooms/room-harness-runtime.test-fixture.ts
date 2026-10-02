import type { RoomHarnessRuntime } from './harness-adapter'

const unexpected = (): never => {
  throw new Error('Unexpected room runtime call')
}

export function roomHarnessRuntimeFixture(
  overrides: Partial<RoomHarnessRuntime> = {}
): RoomHarnessRuntime {
  return {
    createAgentSession: unexpected,
    ensureAgentSession: unexpected,
    sendTerminalAgentPrompt: unexpected,
    waitForTerminalAgentInputReady: unexpected,
    compactTerminalAgentSession: unexpected,
    getTerminalAgentStatus: unexpected,
    getTerminalProcessIncarnation: unexpected,
    closeTerminal: unexpected,
    waitForTerminal: unexpected,
    listRoomRunningAgents: unexpected,
    listRoomExistingAgents: unexpected,
    resolveRoomHistoricalSession: unexpected,
    stageRoomAttachment: unexpected,
    ...overrides
  }
}
