import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import type { AgentPhase } from '../../../shared/agent-transitions'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import type { OrchestrationDb } from './db'

// A turn waiting on the user (approval or question) has not finished, so it holds the countdown like working.
export function terminalPhaseInTurn(phase: AgentPhase | undefined): boolean {
  return phase === 'working' || phase === 'needs-you'
}

export function chatStatusInTurn(status: AgentSessionStatusSummary['status'] | undefined): boolean {
  return status === 'working' || status === 'attention'
}

/** A finished worker's countdown runs only while its agent rests: a turn suspends it, the next rest restarts it. */
export class WorkerAutoReleaseActivity {
  private readonly chatWorking = new Map<string, boolean>()

  constructor(private readonly getDb: () => OrchestrationDb | null) {}

  observePane(change: AgentPaneChange): void {
    // Every hook event is 'observed'; only phase moves (and seeds) change whether the agent works.
    if (change.kind !== 'observed') {
      this.apply(
        change.paneKey,
        terminalPhaseInTurn(change.kind === 'moved' ? change.to : change.phase)
      )
    }
  }

  observeChat(summary: Pick<AgentSessionStatusSummary, 'sessionId' | 'status'>): void {
    const working = chatStatusInTurn(summary.status)
    if (this.chatWorking.get(summary.sessionId) === working) {
      return
    }
    this.chatWorking.set(summary.sessionId, working)
    const db = this.getDb()
    const paneKey = db && resolveStructuredWorkerIdentityForSession(summary.sessionId, db)?.paneKey
    if (paneKey) {
      this.apply(paneKey, working)
    }
  }

  private apply(paneKey: string, working: boolean): void {
    try {
      const db = this.getDb()
      if (working) {
        db?.suspendWorkerTerminalAutoRelease(paneKey)
      } else {
        db?.restartWorkerTerminalAutoRelease(paneKey)
      }
    } catch (error) {
      console.warn('[orchestration] worker auto-release activity update failed', error)
    }
  }
}
