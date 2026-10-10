import { MAX_TAIL_PENDING_ANSI_CHARS } from './terminal-tail-limits'
import {
  classifyTerminalEscapeIntroducer,
  type TerminalEscapeIntroducer
} from '../../shared/terminal-escape-introducer'
import { ownRetainedString } from '../../shared/own-retained-string'

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
  const params = value.slice(escapeIndex + 2, endIndex)
  const firstParamMatch = /^(\d+)/.exec(params)
  return {
    kind: 'csi',
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
  pendingAnsi: string = ''
): { text: string; pendingAnsi: string } {
  // Why: skip full ANSI/OSC scanning for the common plain-text PTY chunk (perf on high-throughput streams).
  if (pendingAnsi.length === 0 && !terminalChunkNeedsNormalization(chunk)) {
    return { text: chunk, pendingAnsi: '' }
  }
  const combined = `${pendingAnsi}${chunk}`
  const parts: string[] = []
  let textStart = 0
  // Why charCodeAt and spans: `combined[index]` minted a string per code unit, and per-sequence
  // params were sliced and regex-matched even for the colour codes the preview drops.
  for (let index = 0; index < combined.length; index += 1) {
    const code = combined.charCodeAt(index)
    if (code >= 0x20 && code < 0x7f) {
      continue
    }
    if (code === 0x1b) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      if (index + 1 >= combined.length) {
        return { text: parts.join(''), pendingAnsi: combined.slice(index) }
      }
      const introducer = classifyTerminalEscapeIntroducer(combined.charCodeAt(index + 1))
      const endIndex = findTerminalEscapeSequenceEnd(combined, index, introducer)
      if (endIndex === -1) {
        return {
          text: parts.join(''),
          // Own the tail so it stops pinning the consumed chunk it was sliced from.
          pendingAnsi: ownRetainedString(trimPendingAnsiControl(combined.slice(index)))
        }
      }
      if (
        introducer === 'csi' &&
        isTerminalPreviewLineControlFinal(combined.charCodeAt(endIndex))
      ) {
        const parsed = parseAnsiControlSequence(combined, index)
        if (parsed?.kind === 'csi' && isTerminalPreviewLineControl(parsed)) {
          // Why: Codex redraws status text with ANSI controls but no CR; keep them so the tail overwrites the prior frame.
          parts.push(combined.slice(index, endIndex + 1))
        }
      }
      index = endIndex
      textStart = index + 1
      continue
    }
    if (code === 0x0d && combined.charCodeAt(index + 1) === 0x0a) {
      // CRLF keeps only its LF, which starts the next span.
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      textStart = index + 1
      continue
    }
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d) {
      continue
    }
    if (!isTerminalPreviewPrintableCodeUnit(code)) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      textStart = index + 1
    }
  }
  appendTerminalNormalizedSpan(parts, combined, textStart, combined.length)
  return { text: parts.join(''), pendingAnsi: '' }
}

function appendTerminalNormalizedSpan(
  parts: string[],
  value: string,
  start: number,
  end: number
): void {
  if (end > start) {
    parts.push(value.slice(start, end))
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

/** The CSI finals `isTerminalPreviewLineControl` can keep: K, A, G, `, D, C. */
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
  if (!hasCanonicalNumericCsiParams(parsed.params)) {
    return false
  }
  if (parsed.final === 'K') {
    const mode = parsed.firstParam ?? 0
    return mode === 0 || mode === 1 || mode === 2
  }
  return (
    parsed.final === 'A' ||
    parsed.final === 'G' ||
    parsed.final === '`' ||
    parsed.final === 'D' ||
    parsed.final === 'C'
  )
}
