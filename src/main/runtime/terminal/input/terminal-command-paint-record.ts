import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { commandMarkAgent } from '../output/command-finish-arbiter'
import { TerminalCommandPaint, type CommandPaintMarks } from './terminal-command-paint'
import { agentPaintSignal } from './terminal-agent-paint-signal'

/** The pane's latest agent reports, as its record holds them. */
export type TerminalReportHolder = Parameters<typeof commandMarkAgent>[0] & {
  lastOscTitleAt?: number | null
  lastExplicitAgentStatus?: object | null
}

export type TerminalCommandPaintRecord = TerminalReportHolder & {
  commandPaint?: TerminalCommandPaint
}

/** `normalizedText` is the chunk as the tail buffer received it (pending escapes resolved). */
export function observeTerminalCommandPaint(
  record: TerminalCommandPaintRecord,
  data: string,
  normalizedText: string,
  at: number
): CommandPaintMarks {
  record.commandPaint ??= new TerminalCommandPaint()
  return record.commandPaint.observe(data, normalizedText, at, record)
}

export function awaitReattachedTerminalPaint(
  record: TerminalCommandPaintRecord | null | undefined,
  at: number,
  attached = true
): void {
  if (record) {
    record.commandPaint ??= new TerminalCommandPaint()
    record.commandPaint.awaitReattachedPaint(at, attached)
  }
}

export function vouchTerminalSpawn(record: TerminalCommandPaintRecord | null | undefined): void {
  if (record) {
    record.commandPaint ??= new TerminalCommandPaint()
    record.commandPaint.vouchSpawn()
  }
}

/** Without a command boundary or reattach to fence on, every report counts, as before. */
export function isCurrentCommandReport(
  record: TerminalCommandPaintRecord,
  observedAt: number | null | undefined
): boolean {
  return record.commandPaint?.isCurrentReport(observedAt) ?? true
}

/** The agent's own first-party report, current like `isCurrentCommandReport` and not retired. */
export function isCurrentFirstPartyReport(
  record: TerminalCommandPaintRecord,
  status: { updatedAt: number }
): boolean {
  const paint = record.commandPaint
  return !paint || (paint.isCurrentReport(status.updatedAt) && !paint.isRetired({ status }))
}

export function admitRestoredTerminalReport(
  record: TerminalCommandPaintRecord | undefined,
  at: number
): void {
  record?.commandPaint?.admitRestoredReport(at)
}

/** A title or the status a restored report set, current like `isCurrentCommandReport`. */
export function isCurrentCommandStatus(
  record: TerminalCommandPaintRecord,
  titleObservedAt: number | null | undefined
): boolean {
  const paint = record.commandPaint
  return (
    !paint ||
    (paint.isCurrentStatus(titleObservedAt) && !paint.isRetired({ titleAt: record.lastOscTitleAt }))
  )
}

export function hasCommandBoundarySinceReattach(record: TerminalCommandPaintRecord): boolean {
  return record.commandPaint?.hasBoundarySinceReattach() ?? false
}

export function isShellInFront(record: TerminalCommandPaintRecord): boolean {
  return record.commandPaint?.isBetweenCommands() ?? false
}

export function takeReattachedRepaintRequest(
  record: TerminalCommandPaintRecord | undefined
): boolean {
  return record?.commandPaint?.takeReattachedRepaintRequest() ?? false
}

/** Spends the one reattach repaint request on `ask`; a request no host was asked for stays for a later ask. */
export function spendReattachedRepaintRequest(
  record: TerminalCommandPaintRecord | undefined,
  ask: () => Promise<boolean> | undefined
): void {
  const paint = record?.commandPaint
  if (paint?.takeReattachedRepaintRequest()) {
    void ask()?.then((asked) => asked || paint.returnReattachedRepaintRequest())
  }
}

/** Without markers (older fish, relay zsh, unwrapped shells, cmd.exe /K startup args), any output is the only paint evidence. */
export function hasTerminalCommandPainted(record: TerminalCommandPaintRecord): boolean {
  return record.commandPaint?.hasPainted() ?? true
}

/** Whether `agent`'s command painted: its own composer marker where it has one, else any visible
 *  post-marker byte. Shares the markerless and lost-history defaults of `hasTerminalCommandPainted`.
 *
 *  Accepted trade-off (STA-2380 C2): a known Claude whose command-start history is complete but
 *  whose build or platform never sends the supported composer signal (`❯`+NBSP after DECSET 2031;
 *  the scanner's quiet fallback is deliberately not read here), and whose `✳` rest title is also
 *  off, now stays pending until the wait's own timeout instead of settling on quiet. There is no
 *  silence-only fallback by design: silence under a shell auto-title was the false-ready bug, and
 *  a reported timeout is recoverable where a lost dispatch is not. The marker has been seen in
 *  captures from 2.1.291 through 2.1.316; no older-version cutoff is claimed. Unchanged and still
 *  failing open: shells that send no OSC 133;C marker and panes whose output history has a gap
 *  report "painted" (the pre-existing `?? true`), so this does not prevent every premature ready. */
export function hasTerminalAgentPainted(
  record: TerminalCommandPaintRecord,
  agent: TuiAgent | null | undefined
): boolean {
  const signal = agentPaintSignal(agent)
  if (signal === null) {
    return hasTerminalCommandPainted(record)
  }
  return record.commandPaint?.hasAgentComposer(signal) ?? true
}
