import WebSocket from 'ws'
import {
  buildServeSimPasteChordFrames,
  encodeServeSimKeyboardFrame,
  SERVE_SIM_TEXT_INSERT_MAX_BYTES,
  type ServeSimKeyboardFrame
} from '../../shared/emulator-keyboard-frame'
import { EmulatorError } from './emulator-errors'
import { setIosSimulatorPasteboardText } from './ios-simulator-pasteboard'

// Why: 0ms worked in repeated hardware probes; 50ms absorbs pasteboard-daemon
// scheduling jitter without a perceptible pause.
const PASTEBOARD_SETTLE_DELAY_MS = 50
// Why: CoreSimulator can drop HID frames delivered in the same tick; matches
// the gesture sender's pacing.
const CHORD_FRAME_DELAY_MS = 16
const RELEASE_TIMEOUT_MS = 1_000

export type InsertServeSimPasteboardTextArgs = {
  udid: string
  text: string
  wsUrl: string | null
}

export type InsertServeSimPasteboardTextDeps = {
  frameDelayMs?: number
  setPasteboardText?: typeof setIosSimulatorPasteboardText
  settleDelayMs?: number
}

// Why: an insertion is a three-step sequence (pbcopy → settle → Cmd+V) against
// one shared device pasteboard. Concurrent calls for the same device would
// interleave, so an earlier chord could paste text a later call already
// overwrote. Serialize per udid; different devices stay independent.
const deviceInsertionChains = new Map<string, Promise<unknown>>()

function enqueueForDevice<T>(udid: string, run: () => Promise<T>): Promise<T> {
  const pending = deviceInsertionChains.get(udid) ?? Promise.resolve()
  // Run after the predecessor settles either way: a failed insertion must not
  // wedge the queue for the device.
  const result = pending.then(run, run)
  const chain = result.then(
    () => {},
    () => {}
  )
  deviceInsertionChains.set(udid, chain)
  void chain.then(() => {
    if (deviceInsertionChains.get(udid) === chain) {
      deviceInsertionChains.delete(udid)
    }
  })
  return result
}

// Inserts arbitrary Unicode text by replacing the device pasteboard and
// pressing Cmd+V. Unlike per-usage HID typing, this is independent of the
// simulator's hardware-keyboard layout, but it does overwrite the device
// (not host) clipboard.
export async function insertServeSimPasteboardText(
  args: InsertServeSimPasteboardTextArgs,
  deps: InsertServeSimPasteboardTextDeps = {}
): Promise<void> {
  const { udid, text, wsUrl } = args
  if (!wsUrl) {
    throw new EmulatorError(
      'emulator_no_active',
      'No active emulator stream for text input — attach the simulator first.'
    )
  }
  if (Buffer.byteLength(text, 'utf8') > SERVE_SIM_TEXT_INSERT_MAX_BYTES) {
    throw new EmulatorError(
      'emulator_error',
      'Text is too large for emulator pasteboard insertion.'
    )
  }
  const setPasteboardText = deps.setPasteboardText ?? setIosSimulatorPasteboardText
  // Validation above stays outside the queue so bad requests fail fast instead
  // of waiting behind (or delaying) an in-flight insertion.
  await enqueueForDevice(udid, async () => {
    await setPasteboardText(udid, text)
    await delay(deps.settleDelayMs ?? PASTEBOARD_SETTLE_DELAY_MS)
    await sendServeSimKeyboardFrameSequence(wsUrl, buildServeSimPasteChordFrames(), {
      frameDelayMs: deps.frameDelayMs
    })
  })
}

export async function sendServeSimKeyboardFrameSequence(
  wsUrl: string,
  frames: ServeSimKeyboardFrame[],
  options: { frameDelayMs?: number } = {}
): Promise<void> {
  const frameDelayMs = options.frameDelayMs ?? CHORD_FRAME_DELAY_MS
  const heldUsages: number[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      let index = 0
      let timer: NodeJS.Timeout | null = null
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      const sendNext = (): void => {
        if (index >= frames.length) {
          cleanup()
          timer = setTimeout(() => {
            ws.close()
            resolve()
          }, 50)
          return
        }
        const frame = frames[index++]
        ws.send(Buffer.from(encodeServeSimKeyboardFrame(frame)))
        trackHeldUsage(heldUsages, frame)
        timer = setTimeout(sendNext, frameDelayMs)
      }
      ws.on('open', sendNext)
      ws.on('error', (error) => {
        cleanup()
        reject(error)
      })
      ws.on('close', () => {
        cleanup()
        if (index < frames.length) {
          reject(new Error('Emulator keyboard stream closed before all frames were sent'))
        }
      })
    })
    heldUsages.length = 0
  } finally {
    if (heldUsages.length > 0) {
      // Why: CoreSimulator keeps a sent "down" pressed across socket loss, so a
      // failed chord would leave Cmd held and turn the next keystroke into a
      // shortcut. Release over a fresh connection, best-effort.
      await releaseHeldUsages(wsUrl, heldUsages, frameDelayMs).catch(() => {})
    }
  }
}

function trackHeldUsage(heldUsages: number[], frame: ServeSimKeyboardFrame): void {
  if (frame.type === 'down') {
    heldUsages.push(frame.usage)
    return
  }
  const lastIndex = heldUsages.lastIndexOf(frame.usage)
  if (lastIndex !== -1) {
    heldUsages.splice(lastIndex, 1)
  }
}

async function releaseHeldUsages(
  wsUrl: string,
  heldUsages: number[],
  frameDelayMs: number
): Promise<void> {
  const releases: ServeSimKeyboardFrame[] = heldUsages
    .toReversed()
    .map((usage) => ({ type: 'up', usage }))
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl)
    let index = 0
    let timer: NodeJS.Timeout | null = null
    const finish = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = null
      ws.close()
      resolve()
    }
    const sendNext = (): void => {
      if (index >= releases.length) {
        finish()
        return
      }
      ws.send(Buffer.from(encodeServeSimKeyboardFrame(releases[index++])))
      timer = setTimeout(sendNext, frameDelayMs)
    }
    ws.on('open', () => {
      if (timer) {
        clearTimeout(timer)
      }
      sendNext()
    })
    ws.on('error', finish)
    timer = setTimeout(finish, RELEASE_TIMEOUT_MS)
  })
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}
