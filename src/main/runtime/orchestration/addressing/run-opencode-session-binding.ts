import { promptOpenCodeSession } from '../../../opencode/opencode-session-prompt'

type StatusRow = {
  agentType?: string
  connectionId: string | null
  providerSession?: { key: string; id: string }
  providerSessionOnly?: boolean
  receivedAt: number
}

type RuntimeStatusSource = {
  getTerminalPaneKey(handle: string): string | null
  getAgentStatusSnapshotForPane?: (paneKey: string) => readonly StatusRow[] | undefined
}

/** Pins a Run to the OpenCode session its coordinator used when the Run was bound. */
export class RunOpenCodeSessionBinding {
  private readonly sessionByRunId = new Map<string, string>()

  constructor(private readonly runtime: RuntimeStatusSource) {}

  bind(runId: string, handle: string): void {
    const paneKey = this.runtime.getTerminalPaneKey(handle)
    const rows = paneKey ? (this.runtime.getAgentStatusSnapshotForPane?.(paneKey) ?? []) : []
    const row = rows
      .filter(
        (entry) =>
          entry.agentType === 'opencode' &&
          entry.connectionId === null &&
          entry.providerSession?.key === 'session_id' &&
          entry.providerSessionOnly !== true
      )
      .sort((left, right) => right.receivedAt - left.receivedAt)[0]
    if (row?.providerSession) {
      this.sessionByRunId.set(runId, row.providerSession.id)
    }
  }

  promptFor(runId: string): ((text: string) => Promise<boolean>) | null {
    const sessionId = this.sessionByRunId.get(runId)
    return sessionId ? (text) => promptOpenCodeSession(sessionId, text) : null
  }
}
