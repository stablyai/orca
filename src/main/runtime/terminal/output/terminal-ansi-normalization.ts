import { MAX_TAIL_PENDING_ANSI_CHARS } from './tail/terminal-tail-limits'
import {
  classifyTerminalEscapeIntroducer,
  type TerminalEscapeIntroducer
} from '../../../../shared/terminal/protocol/escape/terminal-escape-introducer'
import { ownRetainedString } from '../../../../shared/own-retained-string'
import {
  sliceTerminalOrigins,
  terminalOriginSpan,
  writeTerminalOrigins,
  type TerminalOriginRuns
} from '../../../../shared/terminal/output/terminal-content-origin'

export function parseAnsiControlSequence(
  value: string,
  escapeIndex: number
):
  | { kind: 'csi'; final: string; params: string; firstParam: number | null; endIndex: number }
  | {
      kind: 'other'
      endIndex: number
    }
  | null {
  // charCodeAt, not value[i]: indexing mints a one-char string on every escape.
  const introducer = classifyTerminalEscapeIntroducer(value.charCodeAt(escapeIndex + 1))
  const endIndex = findTerminalEscapeSequenceEnd(value, escapeIndex, introducer)
  if (endIndex === -1) {
    return null
  }
  if (introducer !== 'csi') {
    return { kind: 'other', endIndex }
  }
  return parseTerminalCsiAtEnd(value, escapeIndex, endIndex)
}

function parseTerminalCsiAtEnd(value: string, escapeIndex: number, endIndex: number) {
  const params = value.slice(escapeIndex + 2, endIndex)
  const firstParamMatch = /^(\d+)/.exec(params)
  return {
    kind: 'csi' as const,
    final: value[endIndex] ?? '',
    params,
    firstParam: firstParamMatch ? Number(firstParamMatch[1]) : null,
    endIndex
  }
}

/** The index of the sequence's last code unit, or -1 when the input ends first. */
function findTerminalEscapeSequenceEnd(
  value: string,
  escapeIndex: number,
  introducer: TerminalEscapeIntroducer
): number {
  if (introducer === 'csi') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) {
        return index
      }
    }
    return -1
  }
  if (introducer === 'osc' || introducer === 'string') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code === 0x07 && introducer === 'osc') {
        return index
      }
      if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
        return index + 1
      }
    }
    return -1
  }
  return escapeIndex + 1
}

export function hasCanonicalNumericCsiParams(params: string): boolean {
  return /^[0-9;]*$/.test(params)
}

export function containsTerminalVerticalLineControl(value: string): boolean {
  // Only ESC can introduce a vertical control; ordinary output needs no code-unit walk.
  for (let index = value.indexOf('\x1b'); index !== -1; index = value.indexOf('\x1b', index + 1)) {
    const introducer = classifyTerminalEscapeIntroducer(value.charCodeAt(index + 1))
    const endIndex = findTerminalEscapeSequenceEnd(value, index, introducer)
    if (endIndex === -1) {
      return false
    }
    if (
      introducer === 'csi' &&
      value.charCodeAt(endIndex) === 0x41 &&
      hasCanonicalNumericCsiParams(value.slice(index + 2, endIndex))
    ) {
      return true
    }
    index = endIndex
  }
  return false
}

export function normalizeTerminalChunk(
  chunk: string,
  pendingAnsi: string = '',
  origins?: { chunk: TerminalOriginRuns; pending?: TerminalOriginRuns }
): {
  text: string
  pendingAnsi: string
  origins?: TerminalOriginRuns
  pendingOrigins?: TerminalOriginRuns
} {
  // Skip ANSI/OSC scanning for plain-text chunks on the high-throughput PTY path.
  if (pendingAnsi.length === 0 && !terminalChunkNeedsNormalization(chunk)) {
    return {
      text: chunk,
      pendingAnsi: '',
      ...(origins ? { origins: origins.chunk, pendingOrigins: [] } : {})
    }
  }
  const combined = `${pendingAnsi}${chunk}`
  const combinedOrigins = origins
    ? writeTerminalOrigins(
        origins.pending ?? [],
        pendingAnsi.length,
        combined.length,
        origins.chunk
      )
    : undefined
  const out = new NormalizedTerminalText(combined, combinedOrigins)
  let textStart = 0
  // Copy spans and skip parameter parsing for controls the preview discards.
  for (let index = 0; index < combined.length; index += 1) {
    const code = combined.charCodeAt(index)
    if (code >= 0x20 && code < 0x7f) {
      continue
    }
    if (code === 0x1b) {
      out.appendSpan(textStart, index)
      if (index + 1 >= combined.length) {
        return out.finish(combined.slice(index))
      }
      const introducer = classifyTerminalEscapeIntroducer(combined.charCodeAt(index + 1))
      const endIndex = findTerminalEscapeSequenceEnd(combined, index, introducer)
      if (endIndex === -1) {
        // Own the tail so it stops pinning the consumed chunk it was sliced from.
        return out.finish(ownRetainedString(trimPendingAnsiControl(combined.slice(index))))
      }
      if (
        introducer === 'csi' &&
        isTerminalPreviewLineControlFinal(combined.charCodeAt(endIndex))
      ) {
        const parsed = parseTerminalCsiAtEnd(combined, index, endIndex)
        if (isTerminalPreviewLineControl(parsed)) {
          // Preserve Codex ANSI-only redraws so the tail overwrites the previous frame.
          out.appendSpan(index, endIndex + 1)
        }
      }
      index = endIndex
      textStart = index + 1
      continue
    }
    if (code === 0x0d) {
      out.appendSpan(textStart, index)
      out.deferCarriageReturn(index)
      textStart = index + 1
      continue
    }
    if (code === 0x08 || code === 0x09 || code === 0x0a) {
      continue
    }
    if (!isTerminalPreviewPrintableCodeUnit(code)) {
      out.appendSpan(textStart, index)
      textStart = index + 1
    }
  }
  out.appendSpan(textStart, combined.length)
  return out.finish('')
}

/**
 * Holds a CR until the next kept output decides it: before LF it is part of the line ending,
 * and runs of CRs, or CRs split by discarded escapes, act as one. Raw-mode programs end lines
 * with CR CR LF, and an early CR must not erase the row it ends.
 */
class NormalizedTerminalText {
  private readonly parts: string[] = []
  private carriageReturnPending = false
  private length = 0
  private origins: TerminalOriginRuns = []
  private carriageReturnIndex = 0

  constructor(
    private readonly value: string,
    private readonly sourceOrigins?: TerminalOriginRuns,
    private readonly uniformOrigin = sourceOrigins?.length === 1 &&
    sourceOrigins[0]!.start === 0 &&
    sourceOrigins[0]!.end >= value.length
      ? sourceOrigins[0]!.origin
      : undefined
  ) {}

  appendSpan(start: number, end: number): void {
    if (end <= start) {
      return
    }
    if (this.carriageReturnPending && this.value.charCodeAt(start) !== 0x0a) {
      this.parts.push('\r')
      this.appendOrigins(this.carriageReturnIndex, this.carriageReturnIndex + 1)
    }
    this.carriageReturnPending = false
    this.parts.push(this.value.slice(start, end))
    this.appendOrigins(start, end)
  }

  deferCarriageReturn(index: number): void {
    this.carriageReturnPending = true
    this.carriageReturnIndex = index
  }

  private appendOrigins(start: number, end: number): void {
    if (this.sourceOrigins?.length && !this.uniformOrigin) {
      this.origins = writeTerminalOrigins(
        this.origins,
        this.length,
        this.length + end - start,
        sliceTerminalOrigins(this.sourceOrigins, start, end)
      )
    }
    this.length += end - start
  }

  /** An undecided CR stays pending: it may be half of a CRLF split across chunks. */
  finish(pendingTail: string): {
    text: string
    pendingAnsi: string
    origins?: TerminalOriginRuns
    pendingOrigins?: TerminalOriginRuns
  } {
    const pendingStart = this.value.length - pendingTail.length
    const pendingOrigins = this.sourceOrigins
      ? sliceTerminalOrigins(this.sourceOrigins, pendingStart)
      : []
    return {
      text: this.parts.join(''),
      pendingAnsi: this.carriageReturnPending ? `\r${pendingTail}` : pendingTail,
      ...(this.sourceOrigins
        ? {
            origins: this.uniformOrigin
              ? terminalOriginSpan(this.length, this.uniformOrigin)
              : this.origins,
            pendingOrigins: this.carriageReturnPending
              ? writeTerminalOrigins(
                  sliceTerminalOrigins(
                    this.sourceOrigins,
                    this.carriageReturnIndex,
                    this.carriageReturnIndex + 1
                  ),
                  1,
                  1 + pendingTail.length,
                  pendingOrigins
                )
              : pendingOrigins
          }
        : {})
    }
  }
}

function isTerminalPreviewPrintableCodeUnit(code: number): boolean {
  return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)
}

function terminalChunkNeedsNormalization(chunk: string): boolean {
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (
      code === 0x1b ||
      code === 0x7f ||
      code === 0x0d ||
      code < 0x09 ||
      (code > 0x0a && code < 0x20) ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

function trimPendingAnsiControl(value: string): string {
  if (value.length <= MAX_TAIL_PENDING_ANSI_CHARS) {
    return value
  }
  const introducer = value.slice(0, Math.min(2, value.length))
  const suffixBudget = Math.max(0, MAX_TAIL_PENDING_ANSI_CHARS - introducer.length)
  return `${introducer}${value.slice(-suffixBudget)}`
}

/** CSI finals that affect retained preview rows; the sole gate for isTerminalPreviewLineControl. */
function isTerminalPreviewLineControlFinal(code: number): boolean {
  return (
    code === 0x4b ||
    code === 0x41 ||
    code === 0x47 ||
    code === 0x60 ||
    code === 0x44 ||
    code === 0x43
  )
}

function isTerminalPreviewLineControl(parsed: {
  final: string
  params: string
  firstParam: number | null
}): boolean {
  // normalizeTerminalChunk prefilters here; every accepted final must pass the same predicate.
  if (
    !isTerminalPreviewLineControlFinal(parsed.final.charCodeAt(0)) ||
    !hasCanonicalNumericCsiParams(parsed.params)
  ) {
    return false
  }
  if (parsed.final === 'K') {
    const mode = parsed.firstParam ?? 0
    return mode === 0 || mode === 1 || mode === 2
  }
  return true
}
