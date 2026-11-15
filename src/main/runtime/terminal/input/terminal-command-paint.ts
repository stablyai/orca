import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal/output/terminal-osc133-command-finished'
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
export class TerminalCommandPaint {
  private awaitingPaint = false
  private markerEndInChunk = -1
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

  observe(data: string, normalizedText: string): void {
    this.markerEndInChunk = -1
    this.scanner.scan(data)
    if (this.markerEndInChunk !== -1) {
      // Why the rest of this chunk counts: a fast binary can paint in the same read as the marker.
      const commandOutput = data.slice(this.markerEndInChunk)
      this.awaitingPaint = !hasVisibleText(normalizeTerminalChunk(commandOutput).text)
      this.composers = new Map(
        AGENT_PAINT_SIGNALS.map((signal) => [
          signal,
          { scanner: createDraftPasteReadyScanner(signal), seen: false }
        ])
      )
      this.observeComposers(commandOutput)
      return
    }
    if (this.awaitingPaint && hasVisibleText(normalizedText)) {
      this.awaitingPaint = false
    }
    this.observeComposers(data)
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

  hasPainted(): boolean {
    return !this.awaitingPaint
  }

  /** Whether the agent's own composer marker has arrived since the command started; true before any marker, like paint. */
  hasAgentComposer(signal: DraftPasteMarkerSignal): boolean {
    return this.composers === null || (this.composers.get(signal)?.seen ?? false)
  }
}

export type TerminalCommandPaintRecord = { commandPaint?: TerminalCommandPaint }

/** `normalizedText` is the chunk as the tail buffer received it (pending escapes resolved). */
export function observeTerminalCommandPaint(
  record: TerminalCommandPaintRecord,
  data: string,
  normalizedText: string
): void {
  record.commandPaint ??= new TerminalCommandPaint()
  record.commandPaint.observe(data, normalizedText)
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
