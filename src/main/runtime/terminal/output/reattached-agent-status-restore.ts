import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { hookAuthority } from '../../agent-state-rules/agent-state-rules-engine'
import {
  admitRestoredTerminalReport,
  hasCommandBoundarySinceReattach,
  hasTerminalCommandPainted
} from '../input/terminal-command-paint'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { restoreFromReattachedReadyScreen } from '../wait/reattached-ready-screen'
import type { RuledScreen } from '../wait/screen-input-veto'
import { hookLeadTurnState } from '../wait/tui-idle-hook-lane'

export type ReattachedAgentStatusRestoreHost = {
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  getLifecycleGeneration(ptyId: string): number
  collectAgentStatusPaneKeys(ptyId: string): Iterable<string>
  identifyForeground(ptyId: string): Promise<TerminalAgent | null>
  getHeadlessWriteChain(ptyId: string): Promise<unknown> | undefined
  isRetainedFrameProven(ptyId: string, agent: TerminalAgent): Promise<boolean>
  readCaughtUpRuledScreen(ptyId: string): RuledScreen | null
  readOutputClockAt(ptyId: string): number | null
  readLastInputAt(ptyId: string): number | null
  requestRepaint(ptyId: string): void
  applyStatus(ptyId: string, status: AgentStatus, options?: { restoredAtRestAt?: number }): void
}

/** Restores a surviving reattached agent's status from its persisted hook report or repainted ready screen. */
export function runReattachedAgentStatusRestore(
  ptyId: string,
  host: ReattachedAgentStatusRestoreHost
): void {
  const pty = host.getPty(ptyId)
  if (!pty?.connected || pty.lastAgentStatusObservedLive) {
    return
  }
  const { incarnationId } = pty
  const generation = host.getLifecycleGeneration(ptyId)
  const isCurrent = (): boolean =>
    host.getPty(ptyId) === pty &&
    pty.incarnationId === incarnationId &&
    host.getLifecycleGeneration(ptyId) === generation &&
    pty.connected &&
    !pty.lastAgentStatusObservedLive &&
    !hasCommandBoundarySinceReattach(pty)
  const paneKeys = [...host.collectAgentStatusPaneKeys(ptyId)]
  void Promise.all([
    host.identifyForeground(ptyId),
    host.getHeadlessWriteChain(ptyId),
    ...paneKeys.map((paneKey) => agentHookServer.readRestoredAgentStatus(paneKey))
  ]).then(async ([agent, , ...reports]) => {
    const report = reports.find((candidate) => candidate !== null)
    const turn = agent && report ? hookLeadTurnState(report) : null
    const proven = !turn && !!agent && (await host.isRetainedFrameProven(ptyId, agent))
    if (!isCurrent()) {
      return
    }
    if (agent && pty.foregroundAgent === null) {
      pty.foregroundAgent = agent
    }
    if (proven) {
      pty.commandPaint?.vouchRetainedPaint()
    }
    if (turn) {
      const trustsRestoredDone =
        !!agent && isTuiAgent(agent) && hookAuthority(agent) !== 'identity-only'
      const receivedAt = report?.receivedAt
      if (turn === 'done') {
        const lastInputAt = host.readLastInputAt(ptyId)
        if (
          lastInputAt !== null &&
          (receivedAt !== undefined ? receivedAt < lastInputAt : trustsRestoredDone)
        ) {
          return
        }
      }
      host.applyStatus(ptyId, turn === 'done' ? 'idle' : turn, {
        restoredAtRestAt:
          turn === 'done' && trustsRestoredDone && receivedAt !== undefined ? receivedAt : undefined
      })
    } else if (agent) {
      restoreFromReattachedReadyScreen({
        agent,
        readScreen: () => host.readCaughtUpRuledScreen(ptyId),
        readOutputClockAt: () => host.readOutputClockAt(ptyId),
        hasPaintedSinceReattach: () => hasTerminalCommandPainted(pty),
        requestRepaint: () => host.requestRepaint(ptyId),
        isCurrent,
        applyIdle: () => host.applyStatus(ptyId, 'idle')
      })
    }
  })
}

export function admitReattachedAgentStatusRecord(
  pty: RuntimePtyWorktreeRecord | undefined,
  status: AgentStatus,
  restoredAtRestAt?: number
): void {
  admitRestoredTerminalReport(pty, Date.now())
  if (restoredAtRestAt !== undefined && status === 'idle' && pty && !pty.lastExplicitAgentStatus) {
    pty.lastExplicitAgentStatus = {
      state: 'done',
      updatedAt: restoredAtRestAt,
      restoredAtRest: true
    }
  }
}
