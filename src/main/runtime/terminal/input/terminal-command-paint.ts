import { normalizeTerminalTitle } from '../../../../shared/agent-status/title/agent-title-status'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import {
  createOsc133CommandFinishedScanner,
  type Osc133TitleEvent
} from '../../../../shared/terminal/output/terminal-osc133-command-finished'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type {
  DraftPasteMarkerSignal,
  TuiAgentConfig
} from '../../../../shared/agent-launch/catalog/tui-agent-config-types'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  createDraftPasteReadyScanner,
  draftPasteReadySignalHasMarker,
  type DraftPasteReadyScanner
} from '../../../../shared/draft-paste-ready-scanner'
import { normalizeTerminalChunk } from '../output/terminal-ansi-normalization'
import type {
  TerminalContentOrigin,
  TerminalOriginRuns
} from '../../../../shared/terminal/output/terminal-content-origin'

// eslint-disable-next-line no-control-regex -- control bytes are exactly what is not visible.
const VISIBLE_CHARACTER_RE = /[^\s\u0000-\u001f\u007f-\u009f]/

function hasVisibleText(normalizedText: string): boolean {
  return VISIBLE_CHARACTER_RE.test(stripAnsiEscapeSequences(normalizedText))
}

/**
 * The composer marker that says this agent's command painted, for agents whose bare-name title
 * is weak and whose composer draws a marker only the agent emits (Claude: `❯`+NBSP after
 * DECSET 2031, which no shell sends). Why not any visible byte: Orca's zsh OSC 133;C hook runs
 * first in `preexec_functions`, so a later user or framework preexec hook can print before the
 * agent process exists, and a cold-starting agent can print a banner long before its composer
 * (STA-2380). Null for agents whose name-only idle keeps any post-marker paint as corroboration.
 */
function paintSignalOf(config: TuiAgentConfig): DraftPasteMarkerSignal | null {
  const signal = config.draftPasteReadySignal
  return config.workerStartReadsComposerMarker === true &&
    signal !== undefined &&
    draftPasteReadySignalHasMarker(signal)
    ? signal
    : null
}

export function agentPaintSignal(
  agent: TuiAgent | null | undefined
): DraftPasteMarkerSignal | null {
  return agent ? paintSignalOf(TUI_AGENT_CONFIG[agent]) : null
}

/** One scanner per distinct agent-owned marker, so every PTY attributes paint the same way. */
const AGENT_PAINT_SIGNALS: readonly DraftPasteMarkerSignal[] = [
  ...new Set(
    Object.values(TUI_AGENT_CONFIG)
      .map(paintSignalOf)
      .filter((signal): signal is DraftPasteMarkerSignal => signal !== null)
  )
]

/** OSC 133;C follows the prompt/echo; only visible bytes after it prove the running command painted. */
export type TerminalCommandBoundary = { kind: 'start' | 'completion'; paint: TerminalCommandPaint }

export class TerminalCommandPaint {
  constructor(private readonly onBoundary?: (boundary: TerminalCommandBoundary) => void) {}
  commandEpoch = 0
  commandActive: boolean | undefined
  lastBoundaryEnd = -1
  chunkScopes: { offset: number; origin: TerminalContentOrigin }[] = []
  titleReceipt?: TerminalTitleReceipt
  titleStatusOrigin?: TerminalContentOrigin
  private readonly titleEvents = new WeakMap<Osc133TitleEvent, TerminalTitleReceipt>()
  private readonly chunkTitles = new Map<number, TerminalTitleReceipt>()
  private awaitingPaint = false
  private markerEndInChunk = -1
  private commandOutputPrefix = ''
  /** Armed at each command start; absent before the first marker, where no command is attributable. */
  private composers: Map<
    DraftPasteMarkerSignal,
    { scanner: DraftPasteReadyScanner; seen: boolean }
  > | null = null
  private readonly scanner = createOsc133CommandFinishedScanner(
    () => {
      this.commandActive = false
      this.awaitingPaint = false
      this.markerEndInChunk = -1
      this.onBoundary?.({ kind: 'completion', paint: this })
    },
    undefined,
    (endInChunk, outputPrefix) => {
      this.composers = new Map(
        AGENT_PAINT_SIGNALS.map((signal) => [
          signal,
          { scanner: createDraftPasteReadyScanner(signal), seen: false }
        ])
      )
      this.lastBoundaryEnd = endInChunk
      this.commandEpoch += 1
      this.chunkScopes.push({ offset: endInChunk, origin: this.contentOrigin })
      this.commandActive = true
      this.markerEndInChunk = endInChunk
      this.commandOutputPrefix = outputPrefix
      this.onBoundary?.({ kind: 'start', paint: this })
    },
    {
      qualifyScreen: true,
      onTitle: (event) => {
        const receipt = {
          title: normalizeTerminalTitle(event.title),
          origin: this.originAt(event.end)
        }
        this.titleEvents.set(event, receipt)
        this.chunkTitles.set(event.end, receipt)
      },
      onTitleHandoff: (event) => {
        const receipt = this.titleEvents.get(event)
        if (receipt) {
          receipt.handoffEpoch = this.commandEpoch
        }
      }
    }
  )

  get commandBoundaryPending(): boolean {
    return this.scanner.hasPendingCommandStart()
  }

  capturePendingCommandStart(): (() => boolean) | undefined {
    return this.scanner.capturePendingCommandStart()
  }

  observe(data: string, normalizedText: string, initialAlternateScreen?: boolean): void {
    this.scan(data, initialAlternateScreen)
    this.observeVisible(data, normalizedText)
  }

  get contentOrigin(): TerminalContentOrigin {
    return { owner: this, epoch: this.commandEpoch }
  }

  observeTitle(title: string, end: number): void {
    const normalized = normalizeTerminalTitle(title)
    const receipt = this.chunkTitles.get(end)
    this.titleReceipt =
      receipt?.title === normalized ? receipt : { title: normalized, origin: this.originAt(end) }
  }

  originAt(offset: number): TerminalContentOrigin {
    let origin = this.chunkScopes[0]?.origin ?? this.contentOrigin
    for (const scope of this.chunkScopes) {
      if (scope.offset > offset) {
        break
      }
      origin = scope.origin
    }
    return origin
  }

  chunkOrigins(length: number): TerminalOriginRuns {
    return this.chunkScopes
      .map((scope, index) => ({
        start: scope.offset,
        end: this.chunkScopes[index + 1]?.offset ?? length,
        origin: scope.origin
      }))
      .filter((run) => run.end > run.start)
  }

  scan(data: string, initialAlternateScreen?: boolean): void {
    this.chunkScopes = [{ offset: 0, origin: this.contentOrigin }]
    this.chunkTitles.clear()
    this.markerEndInChunk = -1
    this.commandOutputPrefix = ''
    this.lastBoundaryEnd = -1
    this.lastBoundaryEnd = Math.max(
      this.scanner.scan(data, initialAlternateScreen),
      this.lastBoundaryEnd
    )
  }

  observeVisible(data: string, normalizedText: string): void {
    if (this.markerEndInChunk !== -1) {
      // Why the rest of this chunk counts: a fast binary can paint in the same read as the marker.
      const commandOutput = this.commandOutputPrefix + data.slice(this.markerEndInChunk)
      this.awaitingPaint = !hasVisibleText(normalizeTerminalChunk(commandOutput).text)
      this.observeComposers(commandOutput)
      return
    }
    if (this.awaitingPaint && hasVisibleText(normalizedText)) {
      this.awaitingPaint = false
    }
    this.observeComposers(data)
  }

  private observeComposers(data: string): void {
    if (this.commandActive !== true || !this.composers || data.length === 0) {
      return
    }
    for (const composer of this.composers.values()) {
      if (!composer.seen && composer.scanner.observe(data).ready) {
        composer.seen = true
      }
    }
  }

  hasPainted(): boolean {
    return !this.awaitingPaint
  }

  /** Whether the agent's own composer marker has arrived since the command started; true before any marker, like paint. */
  hasAgentComposer(signal: DraftPasteMarkerSignal): boolean {
    return this.composers === null || (this.composers.get(signal)?.seen ?? false)
  }

  hasObservedAgentComposer(signal: DraftPasteMarkerSignal): boolean {
    return this.composers?.get(signal)?.seen === true
  }
}

export type TerminalCommandPaintRecord = { commandPaint?: TerminalCommandPaint }
type TerminalTitleReceipt = { title: string; origin: TerminalContentOrigin; handoffEpoch?: number }

/** `normalizedText` is the chunk as the tail buffer received it (pending escapes resolved). */
export function observeTerminalCommandPaint(
  record: TerminalCommandPaintRecord &
    Pick<RuntimePtyWorktreeRecord, 'foregroundAgent' | 'lastExplicitAgentStatus'>,
  data: string,
  normalizedText?: string,
  context?: { alternateScreen?: boolean; onBoundary?: (boundary: TerminalCommandBoundary) => void }
): void {
  const epoch = record.commandPaint?.commandEpoch ?? 0
  const active = record.commandPaint?.commandActive
  record.commandPaint ??= new TerminalCommandPaint(context?.onBoundary)
  if (normalizedText === undefined) {
    record.commandPaint.scan(data, context?.alternateScreen)
  } else {
    record.commandPaint.observe(data, normalizedText, context?.alternateScreen)
  }
  if (epoch !== record.commandPaint.commandEpoch || active !== record.commandPaint.commandActive) {
    record.foregroundAgent = null
    record.lastExplicitAgentStatus = null
  }
}

export function terminalTitleIsPredecessor(
  record: TerminalCommandPaintRecord & { lastOscTitle?: string | null },
  title: string | null | undefined = record.lastOscTitle
): boolean {
  const paint = record.commandPaint
  const receipt = paint?.titleReceipt
  return (
    !!paint &&
    !!receipt &&
    receipt.title === title &&
    terminalOriginIsPredecessor(paint, receipt.origin)
  )
}

export function terminalOriginIsPredecessor(
  paint: TerminalCommandPaint,
  origin: TerminalContentOrigin | undefined
): boolean {
  return (
    !!origin &&
    origin.owner === paint &&
    origin.epoch < paint.commandEpoch &&
    !(
      paint.titleReceipt?.origin === origin &&
      paint.titleReceipt.handoffEpoch === paint.commandEpoch
    )
  )
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
