import { stripAnsiEscapeSequences } from '../../../../shared/terminal/protocol/escape/ansi-escape-sequences'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal/output/terminal-osc133-command-finished'
import type { DraftPasteMarkerSignal } from '../../../../shared/agent-launch/catalog/tui-agent-config-types'
import {
  createDraftPasteReadyScanner,
  type DraftPasteReadyScanner
} from '../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'
import { AGENT_PAINT_SIGNALS } from './terminal-agent-paint-signal'
import { normalizeTerminalChunk } from '../output/terminal-ansi-normalization'
import { commandMarkAgent } from '../output/command-finish-arbiter'
import type { TerminalReportHolder } from './terminal-command-paint-record'

// eslint-disable-next-line no-control-regex -- control bytes are exactly what is not visible.
const VISIBLE_CHARACTER_RE = /[^\s\u0000-\u001f\u007f-\u009f]/

function hasVisibleText(normalizedText: string): boolean {
  return VISIBLE_CHARACTER_RE.test(stripAnsiEscapeSequences(normalizedText))
}

export type CommandPaintMarks = { finishHeld: boolean; heldFinishStarted: boolean }

/** OSC 133;C follows the prompt/echo; only visible bytes after it prove the running command painted. */
export class TerminalCommandPaint {
  private awaitingPaint = false
  private repaintRequestable = false
  /** Between OSC 133;D and the next 133;C the shell owns the pane: no command is there to paint. */
  private betweenCommands = false
  /** When the current command started, or the reattach that hid its start; null before any marker. */
  private startedAt: number | null = null
  /** Whether this run saw the process start, or already fenced the reattach that hid it. */
  private reattach: 'unknown' | 'vouched' | 'armed' = 'unknown'
  /** A 133;C parsed since the last 133;D or reattach fence; later ones are the agent's own. */
  private startSeen = false
  /** A command finished or started since the reattach fence; lost output never erases it. */
  private boundarySinceReattach = false
  // Output lost before this process was proven could hide a boundary, so its retained frame can't be vouched.
  private gapSinceReattach = false
  private repaintOffered = false
  /** The last read finished a command and started the next. Its reports are stamped after this
   *  observer runs, so none of them count; at the next read they are retired by identity (a
   *  millisecond clock cannot order them) and that read's arrival starts the new command. */
  private startFollowsFinishInRead = false
  private retiredTitleAt: number | null = null
  private retiredStatus: object | null = null
  /** When a report restored across the reattach was admitted for the process now running. */
  private restoredReportAt: number | null = null
  private markerEndInChunk = -1
  /** A finish mark in a pane with an agent, held until the foreground read says whose it was: the
   *  reports it would retire. */
  private heldFinish: { titleAt: number | null; status: object | null } | null = null
  /** Armed at each command start; absent before the first marker, where no command is attributable. */
  private composers: Map<
    DraftPasteMarkerSignal,
    { scanner: DraftPasteReadyScanner; seen: boolean }
  > | null = null
  private readonly scanner = createOsc133CommandFinishedScanner(
    () => {},
    (endInChunk) => {
      this.markerEndInChunk = endInChunk
    }
  )

  /** What the arbiter must hear: a finish held for its read (`settleHeldFinish`), and a command
   *  start that proved a held finish the shell's. */
  observe(
    data: string,
    normalizedText: string,
    at: number,
    reports: TerminalReportHolder
  ): CommandPaintMarks {
    if (this.startFollowsFinishInRead) {
      this.startFollowsFinishInRead = false
      this.startedAt = at
      this.retiredTitleAt = reports.lastOscTitleAt ?? null
      this.retiredStatus = reports.lastExplicitAgentStatus ?? null
    }
    this.markerEndInChunk = -1
    let finishEnd = this.scanner.scan(data)
    const marks: CommandPaintMarks = { finishHeld: false, heldFinishStarted: false }
    // A command start before the read answers: the held finish counts, as before.
    if (this.heldFinish && this.markerEndInChunk !== -1) {
      this.settleHeldFinish(true)
      marks.heldFinishStarted = true
    }
    // Why hold: agents (Devin) print their own 133;D at each turn's end; only the shell's ends the command.
    if (finishEnd > this.markerEndInChunk && commandMarkAgent(reports) !== null) {
      this.heldFinish = {
        titleAt: reports.lastOscTitleAt ?? null,
        status: reports.lastExplicitAgentStatus ?? null
      }
      marks.finishHeld = true
      finishEnd = -1
    }
    if (finishEnd > this.markerEndInChunk) {
      // Why keep plain paint: with the shell in front, a command that printed and returned (a
      // background launch) is at rest; but no agent's composer, nor its ready screen (the evidence
      // source closes screen lanes here), speaks for whatever starts next.
      if (this.markerEndInChunk !== -1) {
        this.awaitingPaint = !hasVisibleText(
          normalizeTerminalChunk(data.slice(this.markerEndInChunk)).text
        )
      }
      this.finishCommand(reports.lastOscTitleAt ?? null, reports.lastExplicitAgentStatus ?? null)
      return marks
    }
    if (this.markerEndInChunk !== -1) {
      // Why only at a boundary: an agent that writes its own 133;C mid-session is not a new command.
      // Why a finish before it too: then this C starts the next command, not the agent's own.
      if (!this.startSeen || finishEnd !== -1) {
        this.startedAt = at
        this.startSeen = true
        this.startFollowsFinishInRead = finishEnd !== -1
        this.restoredReportAt = null
        this.boundarySinceReattach = this.reattach === 'armed'
        // Why identity too: a report from the last command can share this read's millisecond.
        if (finishEnd === -1) {
          this.retiredTitleAt = reports.lastOscTitleAt ?? null
          this.retiredStatus = reports.lastExplicitAgentStatus ?? null
        }
      }
      // Why the rest of this chunk counts: a fast binary can paint in the same read as the marker.
      this.runCommand(data.slice(this.markerEndInChunk))
      return marks
    }
    if (this.betweenCommands) {
      return marks
    }
    if (this.awaitingPaint && hasVisibleText(normalizedText)) {
      this.awaitingPaint = false
      this.repaintRequestable = false
    }
    this.observeComposers(data)
    return marks
  }

  private finishCommand(titleAt: number | null, status: object | null): void {
    this.heldFinish = null
    this.betweenCommands = true
    this.boundarySinceReattach = this.reattach === 'armed'
    // Why identity at the finish: a gap later clears betweenCommands, and the finished
    // program's reports must stay retired even then.
    this.retiredTitleAt = titleAt
    this.retiredStatus = status
    this.startSeen = false
    this.repaintRequestable = false
    this.composers = new Map()
  }

  private runCommand(commandOutput: string): void {
    this.betweenCommands = false
    this.repaintRequestable = false
    this.awaitingPaint = !hasVisibleText(normalizeTerminalChunk(commandOutput).text)
    this.composers = new Map(
      AGENT_PAINT_SIGNALS.map((signal) => [
        signal,
        { scanner: createDraftPasteReadyScanner(signal), seen: false }
      ])
    )
    this.observeComposers(commandOutput)
  }

  private observeComposers(data: string): void {
    if (!this.composers || data.length === 0) {
      return
    }
    for (const composer of this.composers.values()) {
      if (!composer.seen && composer.scanner.observe(data).ready) {
        composer.seen = true
      }
    }
  }

  /** A reattached process's command start predates this observer, so only its next visible paint
   *  speaks for it; the screen it left may be an earlier program's. Once per process, and never for
   *  one this run saw start or whose command start it has parsed. `attached`: its output now reaches
   *  this observer, so a repaint it is asked for would be seen. */
  awaitReattachedPaint(at: number, attached: boolean): void {
    if (this.reattach === 'unknown' && this.startedAt === null) {
      this.reattach = 'armed'
      this.startedAt = at
      this.startSeen = false
      this.awaitingPaint = true
      this.composers = null
    }
    if (attached && this.reattach === 'armed' && !this.repaintOffered) {
      this.repaintOffered = true
      this.repaintRequestable = this.awaitingPaint && !this.startSeen
    }
  }

  /** The foreground read for a held finish: the shell's ends the command; the agent's own changes nothing. */
  settleHeldFinish(shellFinished: boolean): void {
    const held = this.heldFinish
    this.heldFinish = null
    if (held && shellFinished) {
      this.finishCommand(held.titleAt, held.status)
    }
  }

  /** This run saw the process start: drop a fence a racing inventory armed before any command start. */
  vouchSpawn(): void {
    if (this.reattach === 'armed' && !this.startSeen) {
      this.startedAt = null
      this.awaitingPaint = this.repaintRequestable = false
    }
    this.reattach = 'vouched'
  }

  /** Output was lost: paint and boundaries since are unknown. A reattached process's retained frame
   *  is never vouched after one, and a fence still awaiting its command holds until a fresh paint;
   *  otherwise every report and any paint count, as with no markers, except the reports a seen
   *  boundary already retired. */
  noteGap(): void {
    this.scanner.reset()
    this.heldFinish = null
    this.gapSinceReattach ||= this.reattach !== 'vouched'
    if (this.awaitsReattachedCommand()) {
      // A gap only arrives on a live stream, so the program can be asked to repaint again.
      this.awaitingPaint = this.repaintRequestable = true
      return
    }
    this.startedAt = null
    this.startSeen = false
    this.startFollowsFinishInRead = false
    this.betweenCommands = false
    this.awaitingPaint = this.repaintRequestable = false
    this.composers = null
    this.restoredReportAt = null
  }

  /** A command finished or started since the reattach fence: the program it hid may be gone. */
  hasBoundarySinceReattach(): boolean {
    return this.boundarySinceReattach
  }

  /** A reattach fence with no command boundary since: the program it hid is still the one running. */
  awaitsReattachedCommand(): boolean {
    return this.reattach === 'armed' && !this.startSeen && !this.betweenCommands
  }

  admitRestoredReport(at: number): void {
    this.restoredReportAt = at
  }

  /** Whether the pane's status, last titled at `titleObservedAt`, speaks for the command now running. */
  isCurrentStatus(titleObservedAt: number | null | undefined): boolean {
    return this.isCurrentReport(
      Math.max(titleObservedAt ?? -Infinity, this.restoredReportAt ?? -Infinity)
    )
  }

  /** Whether this title or status is one a finish-then-start read carried or left in place. */
  isRetired(report: { titleAt?: number | null; status?: object | null }): boolean {
    return (
      (report.titleAt != null && report.titleAt === this.retiredTitleAt) ||
      (report.status != null && report.status === this.retiredStatus)
    )
  }

  /** A ledger saved at quit proved the retained frame is this reattached command's own paint. */
  vouchRetainedPaint(): void {
    if (this.awaitsReattachedCommand() && !this.gapSinceReattach) {
      this.awaitingPaint = this.repaintRequestable = false
    }
  }

  /** True once per reattach while nothing has painted: the one repaint request it allows. */
  takeReattachedRepaintRequest(): boolean {
    const take = this.repaintRequestable
    this.repaintRequestable = false
    return take
  }

  /** No host was asked (a phone or remote desktop owned the grid, or it failed): keep the request. */
  returnReattachedRepaintRequest(): void {
    if (this.awaitingPaint && this.awaitsReattachedCommand()) {
      this.repaintRequestable = true
    }
  }

  /** Whether the agent's own report at `observedAt` speaks for the command now running. */
  isCurrentReport(observedAt: number | null | undefined): boolean {
    return (
      !this.betweenCommands &&
      !this.startFollowsFinishInRead &&
      // Until the foreground read answers, the finished program's reports may be the shell's now.
      this.heldFinish === null &&
      (this.startedAt === null || (typeof observedAt === 'number' && observedAt >= this.startedAt))
    )
  }

  /** A command finished and no next one started: the shell owns the pane. */
  isBetweenCommands(): boolean {
    return this.betweenCommands
  }

  hasPainted(): boolean {
    return !this.awaitingPaint
  }

  /** It painted, it is still the command in front, and its start is known (a 133;C this run, or
   *  the reattach that hid it). Markerless panes never are. */
  hasAttributedPaint(): boolean {
    return (
      !this.awaitingPaint &&
      this.startedAt !== null &&
      !this.betweenCommands &&
      !this.startFollowsFinishInRead
    )
  }

  /** Whether the agent's own composer marker has arrived since the command started; before any
   *  marker, whether it painted, like `hasPainted`. */
  hasAgentComposer(signal: DraftPasteMarkerSignal): boolean {
    return this.composers === null
      ? !this.awaitingPaint
      : (this.composers.get(signal)?.seen ?? false)
  }
}
