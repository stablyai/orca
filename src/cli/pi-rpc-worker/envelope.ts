import { TextDecoder } from 'node:util'
import {
  PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES,
  parsePiRpcWorkerDispatchEnvelope
} from '../../shared/pi-rpc-worker-launch'
import type { PiRpcWorkerDispatchEnvelope } from './types'

export const BRACKETED_PASTE_BEGIN = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'
export const MAX_PRIVATE_ENVELOPE_BYTES = PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export function parsePrivateDispatchEnvelope(json: string): PiRpcWorkerDispatchEnvelope {
  return parsePiRpcWorkerDispatchEnvelope(json)
}

export function stripBracketedPasteEnvelope(input: Uint8Array): string {
  if (input.byteLength > MAX_PRIVATE_ENVELOPE_BYTES) {
    throw new Error('Private dispatch envelope exceeds byte limit')
  }
  let text: string
  try {
    text = UTF8.decode(input)
  } catch {
    throw new Error('Private dispatch envelope is not valid UTF-8')
  }
  if (!text.startsWith(BRACKETED_PASTE_BEGIN)) {
    throw new Error('Private dispatch envelope is not bracketed paste')
  }
  const endIndex = text.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_BEGIN.length)
  if (endIndex === -1) {
    throw new Error('Unterminated private dispatch envelope')
  }
  const suffix = text.slice(endIndex + BRACKETED_PASTE_END.length)
  if (suffix !== '' && suffix !== '\r' && suffix !== '\r\n') {
    throw new Error('Unexpected bytes after private dispatch envelope')
  }
  const body = text.slice(BRACKETED_PASTE_BEGIN.length, endIndex)
  if (body.includes(BRACKETED_PASTE_BEGIN) || body.includes(BRACKETED_PASTE_END)) {
    throw new Error('Multiple private dispatch envelopes are not allowed')
  }
  return body
}

export function decodePrivateDispatchEnvelope(input: Uint8Array): PiRpcWorkerDispatchEnvelope {
  return parsePrivateDispatchEnvelope(stripBracketedPasteEnvelope(input))
}
