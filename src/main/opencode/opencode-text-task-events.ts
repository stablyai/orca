import { z } from 'zod'
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../text-generation/source-control-generation-limits'
import type { createOpenCodeTextTaskHttp } from './opencode-text-task-http'
import { openCodeTextTaskUrl } from './opencode-text-task-http'

const event = z.looseObject({
  type: z.string(),
  data: z.looseObject({ sessionID: z.string() })
})
const textEvent = z.looseObject({
  assistantMessageID: z.string(),
  ordinal: z.number(),
  text: z.string()
})
const permissionEvent = z.looseObject({ id: z.string() })
export function openCodeTextTaskEvents(input: {
  version: 'v1' | 'v2'
  url: string
  signal: AbortSignal
  lost: AbortController
  messageID: string
  context: () => {
    sessionID: string
    owned: boolean
    ownedTree: Set<string>
    directory: string
    http: ReturnType<typeof createOpenCodeTextTaskHttp>
  }
}) {
  const v2 = input.version === 'v2'
  const base = v2 ? '/api/session' : '/session'
  const terminal = Promise.withResolvers<string>()
  void terminal.promise.catch(() => {})
  const stream = new AbortController()
  const streamSignal = AbortSignal.any([stream.signal, input.signal])
  let streamDone: Promise<void> | undefined
  let textBytes = 0
  let promoted = false
  const assistants = new Set<string>()
  const texts = new Map<string, string>()
  const onEvent = async (value: unknown): Promise<void> => {
    const { sessionID, owned, ownedTree, http } = input.context()
    const request = http.request
    const raw = z
      .looseObject({ type: z.string(), properties: z.unknown().optional() })
      .safeParse(value)
    if (!v2 && owned && sessionID && raw.success && raw.data.type === 'session.created') {
      const child = z
        .looseObject({ info: z.looseObject({ id: z.string(), parentID: z.string().optional() }) })
        .safeParse(raw.data.properties)
      if (child.success && child.data.info.parentID && ownedTree.has(child.data.info.parentID)) {
        ownedTree.add(child.data.info.id)
      }
      return
    }
    const parsed = event.safeParse(
      !v2 && raw.success ? { type: raw.data.type, data: raw.data.properties } : value
    )
    if (!parsed.success || !sessionID) {
      return
    }
    const { type, data } = parsed.data
    if (type === 'permission.asked' || (!v2 && type === 'permission.updated')) {
      // Native rejection fans out within a session: borrowed history cannot safely answer it.
      if (ownedTree.has(data.sessionID)) {
        const permission = permissionEvent.parse(data)
        await request(
          'POST',
          type === 'permission.updated'
            ? `${base}/${encodeURIComponent(data.sessionID)}/permissions/${encodeURIComponent(permission.id)}`
            : v2
              ? `${base}/${encodeURIComponent(data.sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`
              : `/permission/${encodeURIComponent(permission.id)}/reply`,
          type === 'permission.updated'
            ? { response: 'reject' }
            : v2
              ? { decision: 'reject', message: 'Tools are unavailable for this text task.' }
              : { reply: 'reject', message: 'Tools are unavailable for this text task.' },
          streamSignal
        )
      }
      return
    }
    if (data.sessionID !== sessionID) {
      return
    }
    if (v2 && !owned) {
      if (type === 'session.inbox.delivered') {
        const delivered = z.looseObject({ inboxID: z.string() }).parse(data)
        if (delivered.inboxID === input.messageID) {
          promoted = true
        } else if (promoted) {
          terminal.reject(new Error('OpenCode naming input was superseded'))
        }
        return
      }
      if (!promoted) {
        return
      }
      if (type === 'session.step.started') {
        assistants.add(
          z.looseObject({ assistantMessageID: z.string() }).parse(data).assistantMessageID
        )
      }
    }
    if (type === 'session.text.ended') {
      const text = textEvent.parse(data)
      if (!owned && !assistants.has(text.assistantMessageID)) {
        return
      }
      const key = `${text.assistantMessageID}:${text.ordinal}`
      textBytes += Buffer.byteLength(text.text) - Buffer.byteLength(texts.get(key) ?? '')
      if (textBytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
        throw new Error('OpenCode text generation exceeded its output limit')
      }
      texts.set(key, text.text)
    } else if (type === 'session.execution.succeeded') {
      terminal.resolve([...texts.values()].join('\n').trim())
    } else if (type === 'session.execution.failed' || type === 'session.execution.interrupted') {
      terminal.reject(new Error('OpenCode did not complete text generation'))
    }
  }
  const subscribe = async (): Promise<void> => {
    const { directory, http } = input.context()
    const response = await fetch(
      openCodeTextTaskUrl(
        input.url,
        `${v2 ? '/api/event' : '/event'}${!v2 ? `?directory=${encodeURIComponent(directory)}` : ''}`,
        input.version
      ),
      { headers: http.headers, signal: streamSignal }
    )
    if (!response.ok || !response.body) {
      throw new Error('OpenCode event stream is unavailable')
    }
    const reader = response.body.getReader()
    streamDone = (async () => {
      const lines = new SearchSubprocessLineAccumulator(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES)
      let pendingBytes = 0
      let frameBytes = 0
      let data: string[] = []
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) {
            throw new Error('OpenCode event stream closed before completion')
          }
          pendingBytes += chunk.value.byteLength
          const frames: string[] = []
          const withinLimit = lines.push(Buffer.from(chunk.value), (rawLine) => {
            const bytes = Buffer.byteLength(rawLine) + 1
            pendingBytes -= bytes
            frameBytes += bytes
            if (frameBytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
              throw new Error('OpenCode text generation exceeded its output limit')
            }
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
            if (!line) {
              if (data.length) {
                frames.push(data.join('\n'))
              }
              data = []
              frameBytes = 0
            } else if (line.startsWith('data:')) {
              data.push(line.slice(5).trimStart())
            }
          })
          if (!withinLimit || frameBytes + pendingBytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
            throw new Error('OpenCode text generation exceeded its output limit')
          }
          for (const frame of frames) {
            await onEvent(JSON.parse(frame))
          }
        }
      } finally {
        lines.clear()
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })().catch((error: unknown) => {
      terminal.reject(error)
      input.lost.abort(error)
    })
  }

  return {
    subscribe,
    completion: terminal.promise,
    get promoted() {
      return promoted
    },
    close: async () => {
      stream.abort()
      await streamDone
    }
  }
}
