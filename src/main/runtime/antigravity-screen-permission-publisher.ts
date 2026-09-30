import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../shared/wsl-hook-relay-contract'
import type { AntigravityScreenPermissionObservation } from '../agent-hooks/server/server-ingest-antigravity-screen'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'
import { isAntigravityCommandApprovalScreen } from './antigravity-command-approval-screen'
import {
  isAntigravityWorkingTerminalScreen,
  isKnownReadyTerminalScreen
} from './terminal-screen-readiness'

type Dependencies = {
  baseline(ptyId: string): AgentStatusIpcPayload | null
  readScreen(ptyId: string): Promise<RuntimeVisibleTerminalState | null>
  isCurrent(ptyId: string, screen: RuntimeVisibleTerminalState): boolean
  publish(observation: AntigravityScreenPermissionObservation): boolean
}

/** A WSL relay row is local screen evidence, but only for a WSL pty in that same distro. */
export function antigravityHookRowMatchesPty(
  rowConnectionId: string | null | undefined,
  pty: { isWsl: boolean | null; wslDistro: string | null }
): boolean {
  if (!rowConnectionId) {
    return true
  }
  return (
    isWslHookRelayConnectionId(rowConnectionId) &&
    pty.isWsl === true &&
    (!pty.wslDistro || rowConnectionId === wslHookRelayConnectionId(pty.wslDistro))
  )
}

export class AntigravityScreenPermissionPublisher {
  private readonly pending = new Map<string, { dirty: boolean }>()

  constructor(private readonly deps: Dependencies) {}

  schedule(ptyId: string): void {
    const existing = this.pending.get(ptyId)
    if (existing) {
      existing.dirty = true
      return
    }
    const pending = { dirty: true }
    this.pending.set(ptyId, pending)
    void this.drain(ptyId, pending).finally(() => {
      this.pending.delete(ptyId)
      if (pending.dirty) {
        this.schedule(ptyId)
      }
    })
  }

  private async drain(ptyId: string, pending: { dirty: boolean }): Promise<void> {
    while (pending.dirty) {
      pending.dirty = false
      const baseline = this.deps.baseline(ptyId)
      if (
        !baseline ||
        baseline.agentType !== 'antigravity' ||
        (baseline.connectionId && !isWslHookRelayConnectionId(baseline.connectionId))
      ) {
        continue
      }
      try {
        const screen = await this.deps.readScreen(ptyId)
        if (!screen || !this.deps.isCurrent(ptyId, screen)) {
          continue
        }
        if (isAntigravityCommandApprovalScreen(screen.lines)) {
          const lines = screen.lines.map((line) => line.trim())
          const start = lines.lastIndexOf('Requesting permission for:')
          const end = lines.lastIndexOf('Run this command?')
          if (start !== -1 && end > start) {
            const command = lines
              .slice(start + 1, end)
              .filter(Boolean)
              .join('\n')
            if (command) {
              this.deps.publish({ baseline, command })
            }
          }
        } else if (isAntigravityWorkingTerminalScreen(screen.lines)) {
          this.deps.publish({ baseline, command: null, clearedState: 'working' })
        } else if (isKnownReadyTerminalScreen({ tail: screen.lines, draft: screen.draft })) {
          this.deps.publish({ baseline, command: null, clearedState: 'done' })
        }
      } catch {
        // An unreadable screen is not evidence that a permission prompt disappeared.
      }
    }
  }
}
