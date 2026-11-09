import { Gzip, strToU8 } from 'fflate'
import {
  trimRetainedItems,
  mergeSubmissions
} from '../../../../src/shared/agent-session/view/structured-agent-session-item-retention'
import { agentSessionHasOlderTranscript } from '../../../../src/shared/agent-session/agent-session-context-clear'
import { DEVICE_STORE_MAX_VALUE_LENGTH } from '../../device-store/device-store-value-codec'
import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import {
  STORED_TRANSCRIPT_VERSION,
  type StoredChatTranscript,
  type StoredStructuredChatTranscript,
  type StoredTerminalChatTranscript
} from './mobile-native-chat-transcript-store'

const MAX_STORED_ROWS = 500
// A sliced encode hands the page back its thread this often, so a big chat never costs a dropped frame run.
const SLICE_MS = 8
// Gzip input per push; small enough to stay well inside one slice on a phone.
const GZIP_CHUNK_BYTES = 64 * 1024
// The window aimed for after a value came out too big, under the cap so the next try fits.
const REFIT_SHARE = 0.9
const MAX_ATTEMPTS = 4
// Base64 input per slice; a multiple of three, so the slices' outputs join into one valid string.
const BASE64_CHUNK_BYTES = 3 * 21_840
// Stands in for the rows in the value's JSON, where the rows' own JSON then goes.
const ROWS_SENTINEL = '\u0000rows\u0000'
const ROWS_TOKEN = JSON.stringify(ROWS_SENTINEL)

/** Gives the page its thread back between slices; null encodes in one go (hide, where the app may stop next). */
export type EncodePause = (() => Promise<void>) | null

function rowsOf(stored: StoredChatTranscript): readonly unknown[] {
  return stored.kind === 'terminal' ? stored.messages : stored.journal.items
}

function terminalWindow(
  stored: StoredTerminalChatTranscript,
  rows: number
): StoredTerminalChatTranscript {
  if (rows >= stored.messages.length) {
    return stored
  }
  // Older rows past the window come back through Load earlier's tail read, so its offset no longer applies.
  return { ...stored, messages: stored.messages.slice(-rows), hasMore: true, beforeOffset: null }
}

function structuredWindow(
  stored: StoredStructuredChatTranscript,
  rows: number
): StoredStructuredChatTranscript {
  const { journal } = stored
  const items = trimRetainedItems(journal.items, rows, rows)
  if (items === journal.items) {
    return stored
  }
  return {
    ...stored,
    journal: {
      ...journal,
      items,
      submissions: mergeSubmissions(journal.submissions, [], items),
      hasOlder: agentSessionHasOlderTranscript(items, true)
    }
  }
}

function windowOf(stored: StoredChatTranscript, rows: number): StoredChatTranscript {
  return stored.kind === 'terminal' ? terminalWindow(stored, rows) : structuredWindow(stored, rows)
}

// The value's JSON with its rows array replaced by the token.
function frameJson(stored: StoredChatTranscript): string {
  const framed =
    stored.kind === 'terminal'
      ? { ...stored, messages: ROWS_SENTINEL }
      : { ...stored, journal: { ...stored.journal, items: ROWS_SENTINEL } }
  return JSON.stringify({ v: STORED_TRANSCRIPT_VERSION, stored: framed })
}

/**
 * The newest rows that fit one store value (at most 500), as base64(gzip(JSON)); null when not even one row
 * fits. With a pause, the work runs in slices of a few ms. Each row is stringified once, and a value over the
 * cap is retried with the window its own bytes per row say will fit, never by blind halving.
 */
export async function encodeStoredChatTranscript(
  stored: StoredChatTranscript,
  pause: EncodePause = null
): Promise<string | null> {
  let sliceStart = performance.now()
  const breathe = async (): Promise<void> => {
    if (pause && performance.now() - sliceStart >= SLICE_MS) {
      await pause()
      sliceStart = performance.now()
    }
  }
  const all = rowsOf(stored)
  const json = new Map<unknown, string>()
  for (const row of all.slice(-MAX_STORED_ROWS)) {
    json.set(row, JSON.stringify(row))
    await breathe()
  }
  let rows = Math.min(all.length, MAX_STORED_ROWS)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const window = windowOf(stored, rows)
    const kept = rowsOf(window).map((row) => json.get(row) ?? JSON.stringify(row))
    const frame = frameJson(window)
    const text = frame.replace(ROWS_TOKEN, () => `[${kept.join(',')}]`)
    const value = await base64InSlices(await gzipInSlices(strToU8(text), breathe), breathe)
    if (value.length <= DEVICE_STORE_MAX_VALUE_LENGTH) {
      return value
    }
    // This attempt's encoded bytes per JSON byte say how many of the newest rows fit.
    const perJsonByte = value.length / text.length
    let budget = (DEVICE_STORE_MAX_VALUE_LENGTH * REFIT_SHARE) / perJsonByte - frame.length
    let fit = 0
    for (let at = kept.length - 1; at >= 0 && budget >= kept[at]!.length + 1; at -= 1) {
      budget -= kept[at]!.length + 1
      fit += 1
    }
    if (fit === 0) {
      return null
    }
    rows = Math.min(fit, rows - 1)
    await breathe()
  }
  return null
}

async function gzipInSlices(input: Uint8Array, breathe: () => Promise<void>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const gzip = new Gzip((chunk) => parts.push(chunk))
  for (let offset = 0; offset < input.length; offset += GZIP_CHUNK_BYTES) {
    const end = Math.min(offset + GZIP_CHUNK_BYTES, input.length)
    gzip.push(input.subarray(offset, end), end === input.length)
    await breathe()
  }
  if (input.length === 0) {
    gzip.push(input, true)
  }
  if (parts.length === 1) {
    return parts[0]!
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function base64InSlices(bytes: Uint8Array, breathe: () => Promise<void>): Promise<string> {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    parts.push(encodeBase64Bytes(bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)))
    await breathe()
  }
  return parts.join('')
}
