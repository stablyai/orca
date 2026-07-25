// Newline-delimited JSON-RPC framing for ACP over stdio.
//
// ACP agents write one JSON object per line on stdout (verified against
// `hermes acp` and `omp acp`, both protocol v1). Kept separate from the client
// so framing edge cases — split chunks, blank lines, a partial trailing line,
// non-JSON noise — are unit-testable without spawning a process.

export type JsonRpcMessage = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type AcpLineDecoder = {
  /** Feed a stdout chunk; returns every complete message it completed. */
  push: (chunk: string) => JsonRpcMessage[]
  /** Bytes buffered awaiting a newline — used to enforce a sanity cap. */
  pending: () => number
}

/** Guard against a runaway agent that never emits a newline. One ACP message
 *  can legitimately be large (a file read result), so this is generous. */
export const ACP_MAX_LINE_BYTES = 32 * 1024 * 1024

export function createAcpLineDecoder(
  onMalformed?: (line: string, error: unknown) => void
): AcpLineDecoder {
  let buffer = ''
  return {
    push(chunk: string): JsonRpcMessage[] {
      buffer += chunk
      if (buffer.length > ACP_MAX_LINE_BYTES) {
        // Drop the oversized frame rather than growing without bound; the
        // client surfaces this as a transport error via onMalformed.
        onMalformed?.(`<${buffer.length} bytes without newline>`, new Error('ACP line too long'))
        buffer = ''
        return []
      }
      const messages: JsonRpcMessage[] = []
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trim()
        buffer = buffer.slice(newlineAt + 1)
        if (line.length > 0) {
          try {
            const parsed: unknown = JSON.parse(line)
            // Why: agents occasionally emit a stray non-object line (a banner
            // that escaped stdout hygiene). Skip it rather than crashing the
            // chat view.
            if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              messages.push(parsed as JsonRpcMessage)
            } else {
              onMalformed?.(line, new Error('ACP frame was not a JSON object'))
            }
          } catch (error) {
            onMalformed?.(line, error)
          }
        }
        newlineAt = buffer.indexOf('\n')
      }
      return messages
    },
    pending() {
      return buffer.length
    }
  }
}

export function encodeAcpMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`
}
