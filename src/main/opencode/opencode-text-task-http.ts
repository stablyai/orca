import { z } from 'zod'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../text-generation/source-control-generation-limits'

const envelope = z.looseObject({ data: z.unknown().optional() })

function unwrap(value: unknown): unknown {
  const parsed = envelope.safeParse(value)
  return parsed.success && parsed.data.data !== undefined ? parsed.data.data : value
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        return text + decoder.decode()
      }
      bytes += chunk.value.byteLength
      if (bytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
        throw new Error('OpenCode text generation exceeded its output limit')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createOpenCodeTextTaskHttp(url: string, password: string, query: string) {
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'content-type': 'application/json'
  }
  const request = async (
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<unknown> => {
    const response = await fetch(`${url}${path}${query}`, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('OpenCode rejected the text generation request')
    }
    const text = await readBounded(response)
    return text ? unwrap(JSON.parse(text)) : undefined
  }
  return { headers, request }
}
