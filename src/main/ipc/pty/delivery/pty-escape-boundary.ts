/** Where each PTY's escape parser stands between accepted payloads, so deliveries that start inside an escape are marked for the renderer. */
import { advanceTerminalEscapeBoundary } from '../../../../shared/terminal/protocol/escape/terminal-partial-escape-tail'

/** An open escape's state prefix, '' at ground, or null when bytes main never saw make it unknown. */
export type PtyEscapeBoundary = string | null

// Absent = ground; most PTYs sit at ground between payloads.
const boundaryByPty = new Map<string, PtyEscapeBoundary>()

const CAN = 0x18
const SUB = 0x1a
const ESC = 0x1b

// ESC starts a sequence and CAN/SUB abort one from any parser state, so the boundary after one is known again.
function firstResyncIndex(data: string): number {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i)
    if (code === ESC || code === CAN || code === SUB) {
      return i
    }
  }
  return -1
}

// xterm also parses 8-bit C1 controls (CSI U+009B, ST U+009C, ...), which the scanner does not follow.
const C1_CONTROL = /[\u0080-\u009f]/

function lastC1Index(data: string): number {
  for (let i = data.length - 1; i >= 0; i--) {
    const code = data.charCodeAt(i)
    if (code >= 0x80 && code <= 0x9f) {
      return i
    }
  }
  return -1
}

export function advanceEscapeBoundary(before: PtyEscapeBoundary, data: string): PtyEscapeBoundary {
  if (C1_CONTROL.test(data)) {
    // Past a C1 control the boundary is unknown until ESC, CAN or SUB re-establishes it.
    return advanceEscapeBoundary(null, data.slice(lastC1Index(data) + 1))
  }
  if (before !== null) {
    return advanceTerminalEscapeBoundary(before, data)
  }
  const resync = firstResyncIndex(data)
  return resync === -1 ? null : advanceTerminalEscapeBoundary('', data.slice(resync))
}

/** Advance over an accepted payload, delivered or dropped; returns the boundary it starts at. */
export function advancePtyEscapeBoundary(id: string, data: string): PtyEscapeBoundary {
  const before = peekPtyEscapeBoundary(id)
  const after = advanceEscapeBoundary(before, data)
  if (after === '') {
    boundaryByPty.delete(id)
  } else {
    boundaryByPty.set(id, after)
  }
  return before
}

/** The boundary at the stream's current position, without consuming bytes. */
export function peekPtyEscapeBoundary(id: string): PtyEscapeBoundary {
  return boundaryByPty.has(id) ? (boundaryByPty.get(id) ?? null) : ''
}

/** A provider (the daemon's background thinning) dropped bytes main never saw. */
export function markPtyEscapeBoundaryUnknown(id: string): void {
  boundaryByPty.set(id, null)
}

/**
 * Payload field for a delivery's start: absent at ground; `midEscape: true` inside an escape main
 * saw open, or 'unknown' after bytes main never saw (a provider gap). Either way it cannot resume
 * a stream after a gap.
 */
export function escapeBoundaryFields(boundary: PtyEscapeBoundary | undefined): {
  midEscape?: true | 'unknown'
} {
  if (boundary === undefined || boundary === '') {
    return {}
  }
  return { midEscape: boundary === null ? 'unknown' : true }
}

export function clearPtyEscapeBoundary(id: string): void {
  boundaryByPty.delete(id)
}

export function _resetPtyEscapeBoundaryForTest(): void {
  boundaryByPty.clear()
}
