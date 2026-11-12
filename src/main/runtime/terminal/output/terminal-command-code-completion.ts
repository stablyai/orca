import type { RuntimeTerminalAgentStatusEvent } from './terminal-agent-status-events'
import { OrcaRuntimeWithApplyTrackedPtyTitle } from './terminal-title-observation'
import type { RuntimePtyTitleTrackerEntry } from '../records/runtime-terminal-state-records'
import { createCommandCodeOutputStatusDetector } from '../../../../shared/command-code-output-status'

type TerminalAgentStatusTarget = Pick<
  RuntimeTerminalAgentStatusEvent,
  'source' | 'paneKey' | 'tabId' | 'worktreeId' | 'connectionId' | 'terminalHandle'
>

export abstract class RuntimeCommandCodeCompletion extends OrcaRuntimeWithApplyTrackedPtyTitle {
  abstract getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined

  private readonly commandCodeDoneCandidates = new Map<
    string,
    {
      prompt: string
      dueAt: number
      timer: ReturnType<typeof setTimeout> | null
    }
  >()

  protected override onIntentionalPtyStopSettled(ptyId: string, stopped: boolean): void {
    this.openCodeRunLifetime.onStopSettled(ptyId, stopped)
    const candidate = this.commandCodeDoneCandidates.get(ptyId)
    if (!candidate) {
      return
    }
    if (stopped) {
      this.cancelCommandCodeDone(ptyId)
    } else if (candidate.timer === null) {
      this.armCommandCodeDone(ptyId, candidate)
    }
  }

  protected override disposePtyTitleTracker(ptyId: string): void {
    this.cancelCommandCodeDone(ptyId)
    super.disposePtyTitleTracker(ptyId)
  }

  private cancelCommandCodeDone(ptyId: string): void {
    const candidate = this.commandCodeDoneCandidates.get(ptyId)
    if (candidate?.timer) {
      clearTimeout(candidate.timer)
    }
    this.commandCodeDoneCandidates.delete(ptyId)
  }

  private armCommandCodeDone(
    ptyId: string,
    candidate: NonNullable<ReturnType<typeof this.commandCodeDoneCandidates.get>>
  ): void {
    candidate.timer = setTimeout(
      () => {
        candidate.timer = null
        if (this.commandCodeDoneCandidates.get(ptyId) !== candidate) {
          return
        }
        const pty = this.ptysById.get(ptyId)
        if (this.intentionalPtyStops.claimExit(ptyId, pty?.incarnationId).includes('reversible')) {
          return
        }
        this.commandCodeDoneCandidates.delete(ptyId)
        if (!pty?.connected) {
          return
        }
        for (const target of this.resolveTerminalAgentStatusTargets(ptyId)) {
          const row = this.getAgentStatusSnapshotForPaneFn?.(target.paneKey)[0]
          if (
            row?.agentType !== 'command-code' ||
            row.state !== 'working' ||
            (row.prompt.trim() && row.prompt.trim() !== candidate.prompt)
          ) {
            continue
          }
          this.onTerminalAgentStatus?.({
            ptyId,
            ...target,
            origin: 'process',
            payload: {
              state: 'done',
              prompt: row.prompt.trim() || candidate.prompt,
              agentType: 'command-code'
            }
          })
        }
      },
      Math.max(0, candidate.dueAt - Date.now())
    )
    candidate.timer.unref?.()
  }

  protected createTerminalSideEffectCommandCodeDetector(
    ptyId: string
  ): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
    return createCommandCodeOutputStatusDetector({
      startupCommand: this.terminalSpawnCommandsByPtyId.get(ptyId) ?? null,
      onWorking: (prompt) => {
        this.cancelCommandCodeDone(ptyId)
        for (const target of this.resolveTerminalAgentStatusTargets(ptyId)) {
          const row = this.getAgentStatusSnapshotForPaneFn?.(target.paneKey)[0]
          const foreground = this.ptysById.get(ptyId)?.foregroundAgent
          if (
            foreground
              ? foreground !== 'command-code'
              : row?.agentType && row.agentType !== 'unknown' && row.agentType !== 'command-code'
          ) {
            continue
          }
          const normalized = prompt.trim()
          if (
            row?.agentType === 'command-code' &&
            row.state === 'done' &&
            (!normalized || normalized === row.prompt.trim())
          ) {
            continue
          }
          this.onTerminalAgentStatus?.({
            ptyId,
            ...target,
            origin: 'process',
            payload: {
              state: 'working',
              prompt: normalized || (row?.state === 'working' ? row.prompt : ''),
              agentType: 'command-code'
            }
          })
        }
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working', prompt })
      },
      onDone: (prompt) => {
        this.cancelCommandCodeDone(ptyId)
        if (prompt.trim()) {
          const candidate = { prompt: prompt.trim(), dueAt: Date.now() + 1500, timer: null }
          this.commandCodeDoneCandidates.set(ptyId, candidate)
          this.armCommandCodeDone(ptyId, candidate)
        }
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-done', prompt })
      }
    })
  }

  /** The panes a PTY's in-band status belongs to: its mounted leaves, else its own pane record. */
  protected resolveTerminalAgentStatusTargets(ptyId: string): TerminalAgentStatusTarget[] {
    const targets = new Map<string, TerminalAgentStatusTarget>()
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const paneKey = this.makeRuntimePaneKey(leaf)
      targets.set(paneKey, {
        source: 'mounted-leaf',
        paneKey,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        connectionId
      })
    }
    const recorded = targets.size === 0 && pty ? this.paneOfPty(pty) : null
    if (pty && recorded?.paneKey) {
      targets.set(recorded.paneKey, {
        source: 'pty-record',
        paneKey: recorded.paneKey,
        tabId: recorded.tabId ?? undefined,
        worktreeId: pty.worktreeId,
        connectionId
      })
    }
    // Why once per chunk and not per payload: the same lookup the renderer-facing IPC boundary
    // runs, and it is the pane's only durable join back to its terminal once the pane key moves.
    if (this.onTerminalAgentStatus) {
      for (const target of targets.values()) {
        const terminalHandle = this.getAgentStatusTerminalHandleForPaneKey(target.paneKey)
        if (terminalHandle) {
          target.terminalHandle = terminalHandle
        }
      }
    }
    return [...targets.values()]
  }
}
