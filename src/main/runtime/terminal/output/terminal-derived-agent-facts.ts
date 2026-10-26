import { OrcaRuntimeWithApplyTrackedPtyTitle } from './terminal-title-observation'
import type {
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import { createCommandCodeOutputStatusDetector } from '../../../../shared/command-code-output-status'
import { extractLastOsc7Uri, extractOscScanTail } from '../../../daemon/osc7-uri-extraction'
import { parseFileUriPathParts } from '../../../daemon/osc7-file-uri'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from '../../runtime-worktree-status-projection'
import type { RuntimeTerminalAgentStatusEvent } from '../../runtime-terminal-contracts'
import { programStatusStateOutlivesProgram } from '../../../../shared/program-status/protocol'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import { isAgentStatusHeldOpenByChildWork } from '../../../../shared/agent-lead-status-fold'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { lapsedProgramStatusChildHold } from '../../../../shared/program-status/agent-status-projector'

// Why: programs report only changes, so a long `working` renews its row inside AGENT_STATUS_STALE_AFTER_MS.
const PROGRAM_STATUS_LEASE_RENEWAL_MS = 10 * 60 * 1000
// Why: the last renewal tick before the row would decay settles an unrefreshed child hold.
const PROGRAM_STATUS_CHILD_HOLD_LAPSE_MS =
  AGENT_STATUS_STALE_AFTER_MS - PROGRAM_STATUS_LEASE_RENEWAL_MS

type TerminalAgentStatusTarget = Pick<
  RuntimeTerminalAgentStatusEvent,
  'source' | 'paneKey' | 'tabId' | 'worktreeId' | 'connectionId' | 'terminalHandle'
>

export abstract class OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector extends OrcaRuntimeWithApplyTrackedPtyTitle {
  abstract getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined

  /** Each live OSC 7501 program's latest row payload; renewed while its PTY keeps a live facet. */
  private readonly liveProgramStatusPayloadByPtyId = new Map<
    string,
    { payload: ParsedAgentStatusPayload; trackedAt: number }
  >()
  private programStatusLeaseTimer: ReturnType<typeof setInterval> | null = null

  protected createTerminalSideEffectCommandCodeDetector(
    ptyId: string
  ): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
    return createCommandCodeOutputStatusDetector({
      startupCommand: this.terminalSpawnCommandsByPtyId.get(ptyId) ?? null,
      onWorking: (prompt) => {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working', prompt })
      },
      onDone: (prompt) => {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-done', prompt })
      }
    })
  }

  protected extractLastOsc7CwdForPty(
    ptyId: string,
    data: string
  ): { path: string; hostname: string } | null {
    const previousTail = this.osc7ScanTailByPtyId.get(ptyId)
    if (!previousTail && !data.includes('\x1b]7;')) {
      return null
    }
    const input = `${previousTail ?? ''}${data}`
    const scanTail = extractOscScanTail(input, 4096)
    if (scanTail.length > 0) {
      this.osc7ScanTailByPtyId.set(ptyId, scanTail)
    } else {
      this.osc7ScanTailByPtyId.delete(ptyId)
    }
    const uri = extractLastOsc7Uri(input)
    const pty = this.ptysById.get(ptyId)
    const pathFlavor = this.pathFlavorForPty(pty)
    return uri
      ? parseFileUriPathParts(uri, {
          pathFlavor,
          remotePosixAuthority: !!pty?.connectionId && pathFlavor !== 'win32',
          wslDistro: pty?.connectionId
            ? undefined
            : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
        })
      : null
  }

  protected recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean } {
    const osc7 = this.extractLastOsc7CwdForPty(ptyId, data)
    const cwd = osc7?.path ?? null
    const cwdChanged =
      cwd !== null && cwd.trim().length > 0 && this.terminalCwdByPtyId.get(ptyId) !== cwd
    if (cwdChanged) {
      this.terminalCwdByPtyId.set(ptyId, cwd)
    }
    if (osc7) {
      if (osc7.hostname) {
        this.terminalFileUriHostnameByPtyId.set(ptyId, osc7.hostname)
      } else {
        this.terminalFileUriHostnameByPtyId.delete(ptyId)
      }
    }
    return { cwd, cwdChanged }
  }

  protected pathFlavorForPty(pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' {
    if (!pty?.connectionId) {
      return process.platform === 'win32' ? 'win32' : 'posix'
    }
    const worktreePath = splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'posix'
  }

  protected emitTerminalAgentStatusEvents(
    ptyId: string,
    chunk: Pick<ProcessedAgentStatusChunk, 'payloads'> & Partial<ProcessedAgentStatusChunk>,
    provenance?:
      | { origin: 'process'; yieldsToHookSince: number }
      | { renewsProgramStatusLease: true }
  ): void {
    const facet = chunk.programStatusFacet
    if (chunk.payloads.length === 0 && facet === undefined) {
      return
    }
    if (facet !== undefined) {
      if (facet && !programStatusStateOutlivesProgram(facet.state)) {
        this.liveProgramStatusFacetPtyIds.add(ptyId)
      } else {
        this.liveProgramStatusFacetPtyIds.delete(ptyId)
      }
    }
    const targets = this.resolveTerminalAgentStatusTargets(ptyId)
    // Why before the payloads: each row this chunk publishes must already carry the program's
    // latest report, or a reader acting between the two (the 133;D drop) sees a stale facet.
    if (facet !== undefined && this.onTerminalProgramStatusFacet) {
      for (const target of targets) {
        try {
          this.onTerminalProgramStatusFacet({ ptyId, paneKey: target.paneKey, facet })
        } catch (err) {
          console.error('[runtime] terminal program status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            err
          })
        }
      }
    }
    for (const payload of chunk.payloads) {
      if (chunk.programStatusPayloads?.has(payload)) {
        this.trackProgramStatusLease(ptyId, payload)
      }
      // Why not gated on a listener: the prompt lifecycle is main's own state, read by
      // terminal waits that run with no status consumer attached.
      this.recordAgentPromptLifecycleState(
        ptyId,
        mapExplicitAgentStateToRuntimeTerminalStatus(payload.state)
      )
      for (const target of targets) {
        if (!this.onTerminalAgentStatus) {
          continue
        }
        try {
          this.onTerminalAgentStatus({
            ptyId,
            ...target,
            payload,
            ...provenance,
            ...(chunk.programStatusPayloads?.has(payload) ? { fromProgramStatus: true } : {}),
            ...(chunk.programStatusRowRemovals?.has(payload)
              ? { removesProgramStatusRow: true }
              : {})
          })
        } catch (err) {
          console.error('[runtime] terminal agent status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            state: payload.state,
            agentType: payload.agentType,
            err
          })
        }
      }
    }
  }

  private trackProgramStatusLease(ptyId: string, payload: ParsedAgentStatusPayload): void {
    if (payload.state === 'done') {
      this.liveProgramStatusPayloadByPtyId.delete(ptyId)
      return
    }
    this.liveProgramStatusPayloadByPtyId.set(ptyId, { payload, trackedAt: Date.now() })
    if (this.programStatusLeaseTimer === null) {
      this.programStatusLeaseTimer = setInterval(
        () => this.renewProgramStatusLeases(),
        PROGRAM_STATUS_LEASE_RENEWAL_MS
      )
      this.programStatusLeaseTimer.unref?.()
    }
  }

  private renewProgramStatusLeases(): void {
    for (const [ptyId, { payload, trackedAt }] of this.liveProgramStatusPayloadByPtyId) {
      if (!this.ptysById.has(ptyId)) {
        this.liveProgramStatusPayloadByPtyId.delete(ptyId)
        continue
      }
      // A child-held row outlives its done root's facet until children report or the hold lapses.
      if (isAgentStatusHeldOpenByChildWork(payload)) {
        const lapsed = lapsedProgramStatusChildHold(
          payload,
          trackedAt,
          Date.now(),
          PROGRAM_STATUS_CHILD_HOLD_LAPSE_MS
        )
        if (lapsed) {
          this.emitTerminalAgentStatusEvents(ptyId, {
            payloads: [lapsed],
            programStatusPayloads: new Set([lapsed])
          })
        }
        continue
      }
      // The live facet set is the authority on whether the program still runs.
      if (!this.liveProgramStatusFacetPtyIds.has(ptyId)) {
        this.liveProgramStatusPayloadByPtyId.delete(ptyId)
        continue
      }
      this.emitTerminalAgentStatusEvents(
        ptyId,
        { payloads: [payload], programStatusPayloads: new Set([payload]) },
        { renewsProgramStatusLease: true }
      )
    }
    if (this.liveProgramStatusPayloadByPtyId.size === 0 && this.programStatusLeaseTimer) {
      clearInterval(this.programStatusLeaseTimer)
      this.programStatusLeaseTimer = null
    }
  }

  override notePtyDataGap(ptyId: string, droppedChars = 0): void {
    super.notePtyDataGap(ptyId, droppedChars)
    // The gap may hold the program's end, and the fresh parser no longer knows its records.
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry && entry.programActivity !== null) {
      entry.tracker.endProgramActivity()
    }
    this.clearLiveProgramStatusFacet(ptyId)
  }

  /** The PTY's program ended: drop its live facet (done/error stay). Call while its panes resolve. */
  protected clearLiveProgramStatusFacet(ptyId: string): void {
    if (this.liveProgramStatusFacetPtyIds.has(ptyId)) {
      this.emitTerminalAgentStatusEvents(ptyId, { payloads: [], programStatusFacet: null })
    }
  }

  /** The panes a PTY's in-band status belongs to: its mounted leaves, else its own pane record. */
  private resolveTerminalAgentStatusTargets(ptyId: string): TerminalAgentStatusTarget[] {
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
