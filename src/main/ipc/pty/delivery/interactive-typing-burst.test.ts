import { beforeEach, describe, expect, it } from 'vitest'
import { INTERACTIVE_OUTPUT_BUDGET_CHARS, INTERACTIVE_OUTPUT_WINDOW_MS } from './constants'
import { shouldSendInteractiveOutputNow } from './interactive'
import { interactiveOutputCharsByPty, lastInputAtByPty } from './visibility-state'

const PTY_ID = 'pty-typing-burst'

/**
 * A Codex composer repaint: one DEC 2026 synchronized frame per keystroke,
 * carrying the closing \x1b[?2026l that releases xterm's render latch. Sized
 * from a real 204x52 capture of codex-cli 0.158.0, whose per-keystroke frames
 * run from a few dozen bytes up to ~1.4KB.
 *
 * Why the fast path matters for this shape specifically: xterm renders nothing
 * while synchronized output is open and force-flushes only after 1000ms, so a
 * repaint diverted to the shared batch flush timer — behind every other pane's
 * output — leaves the pane visually frozen rather than merely late.
 */
function codexFrame(bytes: number): string {
  return `\x1b[?2026h\x1b[1;1H${'x'.repeat(Math.max(0, bytes - 20))}\x1b[?2026l`
}

/**
 * Mirrors the production input path: `noteRendererPtyInput`
 * (src/main/ipc/pty/ipc/write-input.ts:152-155) stamps the input time AND zeroes
 * the pty's interactive budget on every keystroke. A test that only stamps the
 * time would let the budget accumulate across keys and report a fast-path
 * divergence that cannot happen in production.
 */
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
    // 90ms apart: inside INTERACTIVE_OUTPUT_WINDOW_MS, i.e. a fast typist who
    // never pauses long enough to expire the window.
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
    // The budget is per keystroke, so it must still bound one key's blast
    // radius: a TUI dumping megabytes after one keypress cannot ride the
    // immediate path past the budget and starve main's timers.
    const frame = codexFrame(8 * 1024)
    let now = 1_000
    noteRendererPtyInput(now)
    let admitted = 0
    while (shouldSendInteractiveOutputNow(PTY_ID, frame, now + 2)) {
      admitted += 1
      // No new keystroke: the same key's repaints keep arriving.
      now += 1
    }
    expect(admitted * frame.length).toBeLessThanOrEqual(INTERACTIVE_OUTPUT_BUDGET_CHARS)
    expect(admitted).toBeGreaterThan(0)
  })

  it('leaves the fast path when output arrives long after the last keystroke', () => {
    const frame = codexFrame(1400)
    const now = 1_000
    noteRendererPtyInput(now)
    // Unprompted output, well past the input window: throughput work, not echo.
    expect(
      shouldSendInteractiveOutputNow(PTY_ID, frame, now + INTERACTIVE_OUTPUT_WINDOW_MS + 1)
    ).toBe(false)
  })
})
