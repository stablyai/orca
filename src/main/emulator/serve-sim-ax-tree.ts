import { EmulatorError } from './emulator-errors'

const DEFAULT_TIMEOUT_MS = 15_000
// Why: /ax replays the last *cached* tree to every new client before polling the
// device, and polling pauses while no client is connected — so the first event
// can be stale. A fresh event is only written if the tree changed, so we linger
// briefly after the first event and return the last one seen: a follow-up means
// the cache was stale; silence means the cache still matches the device.
const DEFAULT_SETTLE_MS = 800

export type FetchAccessibilityTree = (axUrl: string) => Promise<unknown>

export async function fetchServeSimAccessibilityTree(
  axUrl: string,
  options: { timeoutMs?: number; settleMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetchImpl(axUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      })
    } catch {
      if (controller.signal.aborted) {
        throw timeoutError(axUrl)
      }
      throw new EmulatorError(
        'emulator_no_active',
        `serve-sim accessibility endpoint is unreachable at ${axUrl}. Start the emulator session first.`
      )
    }
    if (!response.ok || !response.body) {
      // Why: a helper spawned by an older serve-sim build may predate /ax.
      throw new EmulatorError(
        'emulator_error',
        `serve-sim /ax endpoint returned HTTP ${response.status}. Restart the emulator session to refresh the helper.`
      )
    }
    const payload = await readSettledSseDataEvent(
      response.body,
      controller,
      options.settleMs ?? DEFAULT_SETTLE_MS
    )
    if (payload === null) {
      throw new EmulatorError(
        'emulator_helper_failed',
        'serve-sim /ax stream ended without an accessibility tree event.'
      )
    }
    try {
      return JSON.parse(payload)
    } catch {
      throw new EmulatorError(
        'emulator_helper_failed',
        'serve-sim /ax returned an unparseable accessibility tree event.'
      )
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function timeoutError(axUrl: string): EmulatorError {
  return new EmulatorError(
    'emulator_error',
    `Timed out waiting for the accessibility tree from ${axUrl}.`
  )
}

const SETTLED = Symbol('settled')

// Returns the payload of the last data event seen up to settleMs after the
// first one (see DEFAULT_SETTLE_MS), or null if the stream ends with none.
async function readSettledSseDataEvent(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  settleMs: number
): Promise<string | null> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let latest: string | null = null
  let settled: Promise<typeof SETTLED> | null = null
  let settleTimer: NodeJS.Timeout | undefined
  // Why: abort must also win over a body that never emits — reads on a stalled
  // stream do not observe the fetch signal on their own.
  const aborted = new Promise<never>((_, reject) => {
    const rejectAborted = (): void => reject(new Error('aborted'))
    if (controller.signal.aborted) {
      rejectAborted()
      return
    }
    controller.signal.addEventListener('abort', rejectAborted, { once: true })
  })
  aborted.catch(() => {})
  try {
    for (;;) {
      const result = await Promise.race(
        settled ? [reader.read(), aborted, settled] : [reader.read(), aborted]
      )
      if (result === SETTLED) {
        return latest
      }
      const { done, value } = result
      if (value) {
        buffer += decoder.decode(value, { stream: true })
        const payload = extractLastDataPayload(buffer)
        if (payload !== null) {
          latest = payload
          settled ??= new Promise((resolve) => {
            settleTimer = setTimeout(() => resolve(SETTLED), settleMs)
          })
        }
        // Keep only the trailing partial event; complete ones are consumed.
        const lastBoundary = buffer.lastIndexOf('\n\n')
        if (lastBoundary !== -1) {
          buffer = buffer.slice(lastBoundary + 2)
        }
      }
      if (done) {
        return latest
      }
    }
  } catch {
    // A tree was captured before the stream aborted or dropped — return it rather
    // than discarding a valid result on an unclean close (helper crash / truncated
    // chunked stream), which also keeps a raw non-EmulatorError off the caller path.
    if (latest !== null) {
      return latest
    }
    if (controller.signal.aborted) {
      throw new EmulatorError(
        'emulator_error',
        'Timed out waiting for the accessibility tree event from serve-sim.'
      )
    }
    // Map an unclean mid-stream failure to the EmulatorError contract callers expect.
    throw new EmulatorError(
      'emulator_helper_failed',
      'serve-sim /ax stream ended unexpectedly. Restart the emulator session and retry.'
    )
  } finally {
    if (settleTimer) {
      clearTimeout(settleTimer)
    }
    reader.releaseLock()
  }
}

function extractLastDataPayload(buffer: string): string | null {
  let payload: string | null = null
  for (const event of buffer.split('\n\n').slice(0, -1)) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    if (dataLines.length > 0) {
      payload = dataLines.join('\n')
    }
  }
  return payload
}
