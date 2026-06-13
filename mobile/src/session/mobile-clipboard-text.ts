import { z } from 'zod'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

export const MOBILE_CLIPBOARD_TEXT_MAX_BYTES = 256 * 1024

const textEncoder = new TextEncoder()
const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

const HostClipboardReadResult = z.object({
  available: z.boolean(),
  text: z.string()
})

const HostClipboardWriteResult = z.object({
  written: z.boolean()
})

function assertRpcSuccess(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

export function getMobileClipboardTextByteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

export function assertMobileClipboardTextWithinLimit(text: string): void {
  if (getMobileClipboardTextByteLength(text) > MOBILE_CLIPBOARD_TEXT_MAX_BYTES) {
    throw new Error('Clipboard text is too large')
  }
}

export function sanitizeTerminalPasteText(text: string, wrap: boolean): string {
  if (!wrap) {
    return text
  }
  // Why: embedded bracketed-paste markers can terminate paste mode early and
  // turn trailing clipboard bytes into commands when we add our own wrapper.
  return text.split(BRACKETED_PASTE_START).join('').split(BRACKETED_PASTE_END).join('')
}

export function buildTerminalTextPastePayload(text: string, wrap: boolean): string {
  const sanitized = sanitizeTerminalPasteText(text, wrap)
  const payload = wrap ? `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}` : sanitized
  assertMobileClipboardTextWithinLimit(payload)
  return payload
}

export async function readHostClipboardText(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<string> {
  const result = HostClipboardReadResult.parse(
    assertRpcSuccess(await client.sendRequest('clipboard.readText', null))
  )
  assertMobileClipboardTextWithinLimit(result.text)
  return result.available ? result.text : ''
}

export async function writeHostClipboardText(
  client: Pick<RpcClient, 'sendRequest'>,
  text: string
): Promise<void> {
  assertMobileClipboardTextWithinLimit(text)
  const result = HostClipboardWriteResult.parse(
    assertRpcSuccess(await client.sendRequest('clipboard.writeText', { text }))
  )
  if (!result.written) {
    throw new Error('Desktop clipboard was not updated')
  }
}
