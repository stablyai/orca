import { isUSKeyboardText } from '../../../shared/emulator/emulator-keyboard-frame'
import { EmulatorError } from '../emulator-errors'
import { planEmulatorTextInput } from '../emulator-text-input-plan'
import { sendScrcpyButton } from './scrcpy-control-input'
import {
  encodeInjectText,
  encodeSetClipboard,
  SCRCPY_CLIPBOARD_TEXT_MAX_BYTES,
  splitScrcpyInjectText
} from './scrcpy-control-protocol'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'

// An app reads the clipboard only when it handles the KEYCODE_PASTE that scrcpy injects
// asynchronously, so the next clipboard write waits this long. With 60 ms between writes, typed
// Cyrillic still came out as repeated letters on an Android 15 emulator.
export const SCRCPY_PASTE_SETTLE_MS = 200

// A burst of pastes must not push taps and keys behind seconds of settle waits.
const MAX_QUEUED_PASTES = 4

type Queued = { done: (ok: boolean) => void } & (
  | { kind: 'text'; text: string; paste: boolean }
  | { kind: 'action'; send: () => boolean }
)

/**
 * Keeps one device's keyboard input, and the pane's touches, in order. US keyboard text stays INJECT_TEXT, which works on
 * every Android version and in Chrome; text with other characters goes through the clipboard.
 */
class ScrcpyInputQueue {
  private readonly queued: Queued[] = []
  private draining = false
  private nextPasteAt = 0

  constructor(private readonly control: ScrcpyControlTarget) {}

  enqueue(item: Queued): boolean {
    // Typed characters batch into one paste while they wait, so only explicit pastes are capped.
    if (
      item.kind === 'text' &&
      item.paste &&
      this.queued.filter((queued) => queued.kind === 'text' && queued.paste).length >=
        MAX_QUEUED_PASTES
    ) {
      return false
    }
    this.queued.push(item)
    if (!this.draining) {
      void this.drain()
    }
    return true
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      for (let item = this.queued.shift(); item; item = this.queued.shift()) {
        if (item.kind === 'action') {
          item.done(runSafely(item.send))
          continue
        }
        // A pasted newline is text; INJECT_TEXT would press Enter and could submit the field.
        if (!needsClipboard(item.text, item.paste)) {
          item.done(runSafely(() => this.inject(item.text)))
          continue
        }
        await sleep(this.nextPasteAt - Date.now())
        // Typed text that arrived meanwhile joins this paste, so characters keep their order.
        const batch = [item]
        let bytes = Buffer.byteLength(item.text, 'utf8')
        for (let next = this.queued[0]; !item.paste && isTypedText(next); next = this.queued[0]) {
          const nextBytes = Buffer.byteLength(next.text, 'utf8')
          // A trailing newline is an Enter press, and one paste has a size limit.
          if (
            batch.at(-1)?.text.endsWith('\n') ||
            bytes + nextBytes > SCRCPY_CLIPBOARD_TEXT_MAX_BYTES
          ) {
            break
          }
          this.queued.shift()
          batch.push(next)
          bytes += nextBytes
        }
        const ok = runSafely(() =>
          this.paste(batch.map((queued) => queued.text).join(''), item.paste)
        )
        this.nextPasteAt = Date.now() + SCRCPY_PASTE_SETTLE_MS
        for (const queued of batch) {
          queued.done(ok)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private inject(text: string): boolean {
    return splitScrcpyInjectText(text.replaceAll('\r', '')).every((chunk) =>
      this.control.sendControl(encodeInjectText(chunk))
    )
  }

  private paste(text: string, paste: boolean): boolean {
    const plan = planEmulatorTextInput(text, { paste, usKeys: false })
    if (plan.kind !== 'paste') {
      return false
    }
    const pasted = !plan.text || this.control.sendControl(encodeSetClipboard(plan.text, true))
    return (
      pasted &&
      Array.from({ length: plan.enterCount }).every(() => sendScrcpyButton(this.control, 'enter'))
    )
  }
}

/** US text is INJECT_TEXT; a pasted newline is text (INJECT_TEXT would press Enter), so it and non-US text use the clipboard. */
function needsClipboard(text: string, paste: boolean): boolean {
  return !isUSKeyboardText(text) || (paste && /[\r\n]/.test(text))
}

function isTypedText(item: Queued | undefined): item is Queued & { kind: 'text' } {
  return item?.kind === 'text' && !item.paste
}

function runSafely(send: () => boolean): boolean {
  try {
    return send()
  } catch {
    // A throwing sender (an unknown key name) fails only its own input, never the queue.
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

const queues = new WeakMap<ScrcpyControlTarget, ScrcpyInputQueue>()

function queueFor(control: ScrcpyControlTarget): ScrcpyInputQueue {
  let queue = queues.get(control)
  if (!queue) {
    queue = new ScrcpyInputQueue(control)
    queues.set(control, queue)
  }
  return queue
}

/** Types `text`, or with `paste` inserts it as one paste that keeps newlines as text. */
export function sendScrcpyText(
  control: ScrcpyControlTarget,
  text: string,
  options: { paste?: boolean } = {}
): Promise<boolean> {
  const paste = options.paste === true
  if (
    needsClipboard(text, paste) &&
    Buffer.byteLength(text.replaceAll('\r', ''), 'utf8') > SCRCPY_CLIPBOARD_TEXT_MAX_BYTES
  ) {
    return Promise.reject(
      new EmulatorError('emulator_unsupported', 'Text is too long for one Android clipboard paste.')
    )
  }
  return new Promise((done, reject) => {
    const queued = queueFor(control).enqueue({ kind: 'text', text, paste, done })
    if (!queued) {
      reject(new EmulatorError('emulator_error', 'Too many pastes are waiting for this device.'))
    }
  })
}

export function sendScrcpyKey(
  control: ScrcpyControlTarget,
  name: string,
  modifiers: { shift?: boolean } = {}
): Promise<boolean> {
  return sendScrcpyInOrder(control, () => sendScrcpyButton(control, name, modifiers))
}

/** Runs `send` after the input queued before it; when nothing is queued it runs at once. */
export function sendScrcpyInOrder(
  control: ScrcpyControlTarget,
  send: () => boolean
): Promise<boolean> {
  return new Promise((done) => queueFor(control).enqueue({ kind: 'action', send, done }))
}
