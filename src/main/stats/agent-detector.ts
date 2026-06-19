import { extractLastOscTitle, detectAgentStatusFromTitle } from '../../shared/agent-detection'
import type { AgentStatus } from '../../shared/agent-detection'
import { extractOscTitleScanTail } from '../../shared/osc-title-scan-tail'
import type { StatsCollector } from './collector'

type PtyAgentState = 'unknown' | 'agent' | 'stopped'

type PtyRecord = {
  state: PtyAgentState
  sessionOpen: boolean
  sessionStartAt: number | null
  lastStatus: AgentStatus | null
  // Why lastMeaningfulOutputAt instead of raw lastOutputAt:
  // The runtime's lastOutputAt advances on every PTY chunk including
  // ANSI-only noise (cursor repositioning, prompt redraws) that normalizes
  // to an empty string. An agent sitting at an idle prompt would appear to
  // be "working" indefinitely under the raw timestamp. We only advance this
  // when the chunk has non-empty content after stripping ANSI/OSC sequences.
  lastMeaningfulOutputAt: number | null
}

type MeaningfulContentDetector = (chunk: string) => boolean

const MEANINGFUL_CONTENT_SCAN_TAIL_LIMIT = 4096

/**
 * Lightweight normalization to detect whether a PTY data chunk contains
 * meaningful (non-ANSI, non-OSC) output. Mirrors the regex passes in
 * orca-runtime.ts normalizeTerminalChunk but avoids importing the runtime.
 */
function hasMeaningfulContent(chunk: string): boolean {
  // Why: large plain-text PTY bursts should not pay the full ANSI stripping
  // chain just to prove they contain visible output.
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (
      code === 0x1b ||
      code === 0x7f ||
      code < 0x09 ||
      (code > 0x0d && code < 0x20) ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      break
    }
    if (code > 0x20) {
      return true
    }
  }

  const stripped = chunk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x1b)?$/g, '') // incomplete OSC tail
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '') // ST-terminated string controls
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][\s\S]*(?:\x1b)?$/g, '') // incomplete string-control tail
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, '') // Fe sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\u0008/g, '') // backspace
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') // non-printable
    .trim()
  return stripped.length > 0
}

/**
 * Per-PTY agent detection state machine.
 *
 * Lifecycle: UNKNOWN → AGENT → STOPPED
 *
 * - UNKNOWN: PTY just spawned, no OSC title seen yet.
 * - AGENT: OSC title detected as an agent. Tracks repeated working→idle
 *   cycles so one long-lived PTY can contribute multiple agent sessions.
 * - STOPPED: PTY exited. Emits agent_stop if a session is still open.
 *
 * Why we keep scanning OSC titles after classification: agent CLIs can stay in
 * one PTY for multiple prompts. If we stopped scanning after the first title,
 * a long-lived Claude/Codex session would collapse multiple work cycles into
 * one giant session and we would never emit the idle-time stop boundaries that
 * the stats design relies on.
 */
// Why: onExit deletes a PTY's record instead of leaving a tombstone, so a data
// chunk delivered AFTER exit (the exit-then-data race during pty.ts shutdown)
// would resurrect a fresh record nothing ever deletes. Remember recently-exited
// ids in a bounded FIFO to refuse resurrection; the cap keeps the guard itself
// bounded, and per-spawn UUID ptyIds are never reused so aged-out ids are safe.
const MAX_EXITED_PTY_IDS = 1024

export class AgentDetector {
  private ptys = new Map<string, PtyRecord>()
  private oscTitleScanTailByPtyId = new Map<string, string>()
  private meaningfulContentScanTailByPtyId = new Map<string, string>()
  private exitedPtyIds = new Set<string>()
  private stats: StatsCollector
  private meaningfulContentDetector: MeaningfulContentDetector

  constructor(stats: StatsCollector, meaningfulContentDetector = hasMeaningfulContent) {
    this.stats = stats
    this.meaningfulContentDetector = meaningfulContentDetector
  }

  /**
   * Called on every PTY data chunk (from orca-runtime.ts onPtyData).
   * Receives raw data BEFORE normalization, since normalizeTerminalChunk
   * strips OSC sequences that we need for agent detection.
   */
  onData(ptyId: string, rawData: string, at: number): void {
    let record = this.ptys.get(ptyId)
    if (!record) {
      // Why: refuse to resurrect a PTY that already exited — a late post-exit
      // data chunk must not create a new tracked record (which nothing deletes).
      if (this.exitedPtyIds.has(ptyId)) {
        return
      }
      record = {
        state: 'unknown',
        sessionOpen: false,
        sessionStartAt: null,
        lastStatus: null,
        lastMeaningfulOutputAt: null
      }
      this.ptys.set(ptyId, record)
    }

    if (record.state === 'stopped') {
      return
    }

    let hasMeaningfulOutput: boolean | null = null
    const previousMeaningfulTail = this.meaningfulContentScanTailByPtyId.get(ptyId)
    const meaningfulData = previousMeaningfulTail ? `${previousMeaningfulTail}${rawData}` : rawData
    const getHasMeaningfulOutput = (): boolean => {
      if (hasMeaningfulOutput === null) {
        hasMeaningfulOutput = this.meaningfulContentDetector(meaningfulData)
        this.updateMeaningfulContentScanTail(ptyId, meaningfulData)
      }
      return hasMeaningfulOutput
    }

    if (record.sessionOpen && getHasMeaningfulOutput()) {
      record.lastMeaningfulOutputAt = at
    }

    const title = this.extractLastOscTitleForPty(ptyId, rawData)
    if (title === null) {
      return
    }

    const status = detectAgentStatusFromTitle(title)
    if (status === null) {
      return
    }

    if (record.state === 'unknown') {
      record.state = 'agent'
      record.lastStatus = status
      record.sessionOpen = true
      record.sessionStartAt = at
      record.lastMeaningfulOutputAt = getHasMeaningfulOutput() ? at : null
      this.stats.onAgentStart(ptyId, at)
      return
    }

    if (record.state !== 'agent') {
      return
    }

    if (record.sessionOpen && record.lastStatus === 'working' && status !== 'working') {
      this.stats.onAgentStop(ptyId, record.lastMeaningfulOutputAt ?? record.sessionStartAt ?? at)
      record.sessionOpen = false
      record.sessionStartAt = null
      record.lastMeaningfulOutputAt = null
    } else if (!record.sessionOpen && record.lastStatus !== 'working' && status === 'working') {
      // Why: after an agent goes idle we consider that work session closed, but
      // the same PTY may later be reused for another prompt. A fresh working
      // title is the start boundary for the next tracked session.
      record.sessionOpen = true
      record.sessionStartAt = at
      record.lastMeaningfulOutputAt = getHasMeaningfulOutput() ? at : null
      this.stats.onAgentStart(ptyId, at)
    }

    record.lastStatus = status
  }

  /**
   * Called when a PTY process exits (from orca-runtime.ts onPtyExit).
   */
  onExit(ptyId: string): void {
    const record = this.ptys.get(ptyId)
    if (!record) {
      return
    }

    if (record.state === 'agent' && record.sessionOpen) {
      // Use lastMeaningfulOutputAt as the effective stop time to avoid
      // inflating duration with idle-at-prompt time.
      const stopAt = record.lastMeaningfulOutputAt ?? record.sessionStartAt ?? Date.now()
      this.stats.onAgentStop(ptyId, stopAt)
    }

    record.state = 'stopped'
    this.ptys.delete(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.meaningfulContentScanTailByPtyId.delete(ptyId)
    // Remember this id (bounded FIFO) so a late data chunk can't resurrect it.
    this.exitedPtyIds.delete(ptyId)
    this.exitedPtyIds.add(ptyId)
    while (this.exitedPtyIds.size > MAX_EXITED_PTY_IDS) {
      const oldest = this.exitedPtyIds.values().next()
      if (oldest.done) {
        break
      }
      this.exitedPtyIds.delete(oldest.value)
    }
  }

  private extractLastOscTitleForPty(ptyId: string, rawData: string): string | null {
    const previousTail = this.oscTitleScanTailByPtyId.get(ptyId)
    if (!previousTail && !rawData.includes('\x1b')) {
      return null
    }
    const input = `${previousTail ?? ''}${rawData}`
    const scanTail = extractOscTitleScanTail(input)
    if (scanTail.length > 0) {
      this.oscTitleScanTailByPtyId.set(ptyId, scanTail)
    } else {
      this.oscTitleScanTailByPtyId.delete(ptyId)
    }
    return extractLastOscTitle(input)
  }

  private updateMeaningfulContentScanTail(ptyId: string, rawData: string): void {
    const tail = extractMeaningfulContentScanTail(rawData)
    if (tail.length > 0) {
      this.meaningfulContentScanTailByPtyId.set(ptyId, tail)
    } else {
      this.meaningfulContentScanTailByPtyId.delete(ptyId)
    }
  }

  get trackedPtyCount(): number {
    return this.ptys.size
  }
}

function extractMeaningfulContentScanTail(value: string): string {
  const escapeIndex = value.lastIndexOf('\x1b')
  if (escapeIndex === -1) {
    return ''
  }
  const parsed = parseMeaningfulControlSequence(value, escapeIndex)
  return parsed === null ? trimMeaningfulContentScanTail(value.slice(escapeIndex)) : ''
}

function parseMeaningfulControlSequence(value: string, escapeIndex: number): number | null {
  const introducer = value[escapeIndex + 1]
  if (!introducer) {
    return null
  }
  if (introducer === '[') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) {
        return index
      }
    }
    return null
  }
  if (introducer === ']') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      if (value[index] === '\u0007') {
        return index
      }
      if (value[index] === '\u001b' && value[index + 1] === '\\') {
        return index + 1
      }
    }
    return null
  }
  if (isStTerminatedStringControlIntroducer(introducer)) {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      if (value[index] === '\u001b' && value[index + 1] === '\\') {
        return index + 1
      }
    }
    return null
  }
  return escapeIndex + 1
}

function isStTerminatedStringControlIntroducer(introducer: string): boolean {
  return introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_'
}

function trimMeaningfulContentScanTail(value: string): string {
  if (value.length <= MEANINGFUL_CONTENT_SCAN_TAIL_LIMIT) {
    return value
  }
  const introducer = value.slice(0, Math.min(2, value.length))
  const suffixBudget = Math.max(0, MEANINGFUL_CONTENT_SCAN_TAIL_LIMIT - introducer.length)
  return `${introducer}${value.slice(-suffixBudget)}`
}
