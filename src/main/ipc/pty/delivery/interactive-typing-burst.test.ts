import { beforeEach, describe, expect, it } from 'vitest'
import { INTERACTIVE_OUTPUT_BUDGET_CHARS, INTERACTIVE_OUTPUT_WINDOW_MS } from './constants'
import { shouldSendInteractiveOutputNow } from './interactive'
import { interactiveOutputCharsByPty, lastInputAtByPty } from './visibility-state'

const PTY_ID = 'pty-typing-burst'

/** Model a Codex synchronized repaint: delaying its closing escape can hold xterm painting until the 1000ms timeout. */
function codexFrame(bytes: number): string {
  return `\x1b[?2026h\x1b[1;1H${'x'.repeat(Math.max(0, bytes - 20))}\x1b[?2026l`
}

/** Mirror production: each keystroke resets both input time and its interactive-output budget. */
function noteRendererPtyInput(now: number): void {
  lastInputAtByPty.set(PTY_ID, now)
  interactiveOutputCharsByPty.set(PTY_ID, 0)
}

function typeKeyAndRepaint(now: number, frame: string): boolean {
  noteRendererPtyInput(now)
  return shouldSendInteractiveOutputNow(PTY_ID, frame, now + 2)
}

describe('interactive output fast path during a continuous typing burst', () => {
  beforeEach(() => {
    lastInputAtByPty.delete(PTY_ID)
    interactiveOutputCharsByPty.delete(PTY_ID)
  })

  it('keeps every repaint of a sustained burst on the fast path', () => {
    // Type again before the interactive window expires.
    const cadenceMs = INTERACTIVE_OUTPUT_WINDOW_MS - 10
    const frame = codexFrame(1400)
    const batched: number[] = []
    let now = 1_000
    for (let key = 0; key < 200; key++) {
      if (!typeKeyAndRepaint(now, frame)) {
        batched.push(key)
      }
      now += cadenceMs
    }

    expect(
      batched,
      `keys diverted off the interactive fast path at 1400-byte frames: ${batched.join(', ')}`
    ).toEqual([])
  })

  it('still cuts off a single keystroke that triggers a flood', () => {
    // One keystroke must not let megabytes bypass batching and starve main timers.
    const frame = codexFrame(8 * 1024)
    let now = 1_000
    noteRendererPtyInput(now)
    let admitted = 0
    while (shouldSendInteractiveOutputNow(PTY_ID, frame, now + 2)) {
      admitted += 1
      now += 1
    }
    expect(admitted * frame.length).toBeLessThanOrEqual(INTERACTIVE_OUTPUT_BUDGET_CHARS)
    expect(admitted).toBeGreaterThan(0)
  })

  it('leaves the fast path when output arrives long after the last keystroke', () => {
    const frame = codexFrame(1400)
    const now = 1_000
    noteRendererPtyInput(now)
    expect(
      shouldSendInteractiveOutputNow(PTY_ID, frame, now + INTERACTIVE_OUTPUT_WINDOW_MS + 1)
    ).toBe(false)
  })
})
