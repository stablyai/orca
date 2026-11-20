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

type Queued = { done: (ok: boolean) => void } & (
  | { kind: 'text'; text: string; paste: boolean }
  | { kind: 'key'; send: () => boolean }
)

/**
 * Keeps one device's keyboard input in order. US keyboard text stays INJECT_TEXT, which works on
 * every Android version and in Chrome; text with other characters goes through the clipboard.
 */
class ScrcpyKeyboardQueue {
  private readonly queued: Queued[] = []
  private draining = false
  private nextPasteAt = 0

  constructor(private readonly control: ScrcpyControlTarget) {}

  enqueue(item: Queued): void {
    this.queued.push(item)
    if (!this.draining) {
      void this.drain()
    }
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      for (let item = this.queued.shift(); item; item = this.queued.shift()) {
        if (item.kind === 'key') {
          item.done(runSafely(item.send))
          continue
        }
        if (isUSKeyboardText(item.text)) {
          item.done(this.inject(item.text))
          continue
        }
        await sleep(this.nextPasteAt - Date.now())
        // Typed text that arrived meanwhile joins this paste, so characters keep their order.
        const batch = [item]
        for (let next = this.queued[0]; !item.paste && isTypedText(next); next = this.queued[0]) {
          this.queued.shift()
          batch.push(next)
        }
        const ok = this.paste(batch.map((queued) => queued.text).join(''), item.paste)
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

function isTypedText(item: Queued | undefined): item is Queued & { kind: 'text' } {
  return item?.kind === 'text' && !item.paste
}

function runSafely(send: () => boolean): boolean {
  try {
    return send()
  } catch {
    // Unknown key names throw from the keycode table.
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

const queues = new WeakMap<ScrcpyControlTarget, ScrcpyKeyboardQueue>()

function queueFor(control: ScrcpyControlTarget): ScrcpyKeyboardQueue {
  let queue = queues.get(control)
  if (!queue) {
    queue = new ScrcpyKeyboardQueue(control)
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
  if (
    !isUSKeyboardText(text) &&
    Buffer.byteLength(text, 'utf8') > SCRCPY_CLIPBOARD_TEXT_MAX_BYTES
  ) {
    return Promise.reject(
      new EmulatorError('emulator_unsupported', 'Text is too long for one Android clipboard paste.')
    )
  }
  return new Promise((done) =>
    queueFor(control).enqueue({ kind: 'text', text, paste: options.paste === true, done })
  )
}

export function sendScrcpyKey(
  control: ScrcpyControlTarget,
  name: string,
  modifiers: { shift?: boolean } = {}
): Promise<boolean> {
  return new Promise((done) =>
    queueFor(control).enqueue({
      kind: 'key',
      send: () => sendScrcpyButton(control, name, modifiers),
      done
    })
  )
}
