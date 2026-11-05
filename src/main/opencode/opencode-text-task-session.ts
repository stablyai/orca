import { randomUUID } from 'node:crypto'
import { createOpenCodeTextTaskHttp } from './opencode-text-task-http'
import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../text-generation/source-control-generation-limits'
import type { OpenCodeTextTaskInput } from './opencode-text-task-input'

export type OpenCodeTextTaskSession = {
  version: 'v1' | 'v2'
  url: string
  password: string
  directory: string
  prompt: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  title?: string
  command?: string
  v1Files?: OpenCodeTextTaskInput['v1Files']
  v2Files?: OpenCodeTextTaskInput['v2Files']
  signal: AbortSignal
}

const RULES = [
  ['*', '*', 'deny'],
  ['read', '*', 'allow'],
  ['grep', '*', 'allow'],
  ['glob', '*', 'allow'],
  ['external_directory', '*', 'allow'],
  ['read', 'mcp:*', 'deny']
] as const
const session = z.looseObject({ id: z.string().min(1) })
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
const reply = z.looseObject({
  info: z.looseObject({ error: z.unknown().optional() }),
  parts: z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))
})

/** The caller owns an exclusive server; session policy is applied before any semantic input. */
export async function runOpenCodeTextTaskSession(input: OpenCodeTextTaskSession): Promise<string> {
  const v2 = input.version === 'v2'
  const base = v2 ? '/api/session' : '/session'
  const query = v2 ? '' : `?directory=${encodeURIComponent(input.directory)}`
  const { headers, request } = createOpenCodeTextTaskHttp(input.url, input.password, query)
  const terminal = Promise.withResolvers<string>()
  void terminal.promise.catch(() => {})
  const stream = new AbortController()
  const lost = new AbortController()
  const activeSignal = AbortSignal.any([input.signal, lost.signal])
  const streamSignal = AbortSignal.any([stream.signal, input.signal])
  let streamDone: Promise<void> | undefined
  let sessionID = ''
  let completed = false
  const texts = new Map<string, string>()
  const onEvent = async (value: unknown): Promise<void> => {
    const parsed = event.safeParse(value)
    if (!parsed.success || parsed.data.data.sessionID !== sessionID || !sessionID) {
      return
    }
    const { type, data } = parsed.data
    if (type === 'session.text.ended') {
      const text = textEvent.parse(data)
      texts.set(`${text.assistantMessageID}:${text.ordinal}`, text.text)
      if (
        [...texts.values()].reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) >
        MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES
      ) {
        throw new Error('OpenCode text generation exceeded its output limit')
      }
    } else if (type === 'permission.asked') {
      const permission = permissionEvent.parse(data)
      await request(
        'POST',
        `${base}/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`,
        {
          decision: 'reject',
          message: 'Tools are unavailable for this text task.'
        },
        streamSignal
      )
    } else if (type === 'session.execution.succeeded') {
      terminal.resolve([...texts.values()].join('\n').trim())
    } else if (type === 'session.execution.failed' || type === 'session.execution.interrupted') {
      terminal.reject(new Error('OpenCode did not complete text generation'))
    }
  }
  try {
    input.signal.throwIfAborted()
    if (v2) {
      // Subscribe before session creation: execution events are volatile.
      const response = await fetch(`${input.url}/api/event`, { headers, signal: streamSignal })
      if (!response.ok || !response.body) {
        throw new Error('OpenCode event stream is unavailable')
      }
      const reader = response.body.getReader()
      streamDone = (async () => {
        const decoder = new TextDecoder()
        let buffered = ''
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) {
              throw new Error('OpenCode event stream closed before completion')
            }
            buffered += decoder.decode(chunk.value, { stream: true })
            if (Buffer.byteLength(buffered) > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
              throw new Error('OpenCode text generation exceeded its output limit')
            }
            let boundary = /\r?\n\r?\n/.exec(buffered)
            while (boundary) {
              const frame = buffered.slice(0, boundary.index)
              buffered = buffered.slice(boundary.index + boundary[0].length)
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n')
              if (data) {
                await onEvent(JSON.parse(data))
              }
              boundary = /\r?\n\r?\n/.exec(buffered)
            }
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      })().catch((error: unknown) => {
        terminal.reject(error)
        lost.abort(error)
      })
    }
    activeSignal.throwIfAborted()
    let agent = input.agent || undefined
    let agents: { name: string; mode: string }[] | undefined
    if (!v2 && agent) {
      agents = z
        .array(z.looseObject({ name: z.string(), mode: z.string() }))
        .parse(await request('GET', '/agent', undefined, activeSignal))
      const selected = agents.find((candidate) => candidate.name === agent)
      // The local CLI falls back to its default primary for missing or subagent selections.
      if (!selected || selected.mode === 'subagent') {
        agent = undefined
      }
    }
    const title = input.title ?? `Orca text generation ${randomUUID()}`
    const created = await request(
      'POST',
      base,
      {
        title,
        ...(agent ? { agent } : {}),
        ...(v2
          ? {
              location: { directory: input.directory },
              ...(input.model
                ? {
                    model: {
                      providerID: input.model.providerID,
                      id: input.model.modelID,
                      ...(input.variant ? { variant: input.variant } : {})
                    }
                  }
                : {}),
              permissions: RULES.map(([action, resource, effect]) => ({ action, resource, effect }))
            }
          : {
              permission: RULES.map(([permission, pattern, action]) => ({
                permission,
                pattern,
                action
              }))
            })
      },
      // Recover the owned ID even if cancellation arrives while creation is in flight.
      AbortSignal.timeout(10_000)
    )
    sessionID = session.parse(created).id
    activeSignal.throwIfAborted()
    let text: string
    if (v2) {
      await request(
        'POST',
        `${base}/${encodeURIComponent(sessionID)}/prompt`,
        { text: input.prompt, ...(input.v2Files?.length ? { files: input.v2Files } : {}) },
        activeSignal
      )
      text = await waitForPromiseWithSignal(terminal.promise, activeSignal)
    } else {
      if (input.command) {
        const commands = z
          .array(
            z.looseObject({
              name: z.string(),
              agent: z.string().optional(),
              subtask: z.boolean().optional()
            })
          )
          .parse(await request('GET', '/command', undefined, activeSignal))
        const command = commands.find((command) => command.name === input.command)
        if (!command) {
          throw new Error('OpenCode command is unavailable')
        }
        if (command.agent && !agents) {
          agents = z
            .array(z.looseObject({ name: z.string(), mode: z.string() }))
            .parse(await request('GET', '/agent', undefined, activeSignal))
        }
        const commandAgent = command.agent ?? agent
        // Explicit subtask commands create child histories with a different read-policy contract.
        if (
          command.subtask === true ||
          (agents?.find((candidate) => candidate.name === commandAgent)?.mode === 'subagent' &&
            command.subtask !== false)
        ) {
          throw new Error('OpenCode subtask command cannot run as a private text task')
        }
      }
      const result = reply.parse(
        await request(
          'POST',
          `${base}/${encodeURIComponent(sessionID)}/${input.command ? 'command' : 'message'}`,
          {
            ...(input.model
              ? {
                  model: input.command
                    ? `${input.model.providerID}/${input.model.modelID}`
                    : input.model
                }
              : {}),
            ...(agent ? { agent } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
            ...(input.command
              ? { command: input.command, arguments: input.prompt }
              : { parts: [...(input.v1Files ?? []), { type: 'text', text: input.prompt }] })
          },
          activeSignal
        )
      )
      if (result.info.error) {
        throw new Error('OpenCode did not complete text generation')
      }
      text = result.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
    }
    if (!text) {
      throw new Error('OpenCode returned an empty text response')
    }
    completed = true
    return text
  } finally {
    stream.abort()
    await streamDone
    if (sessionID) {
      const path = `${base}/${encodeURIComponent(sessionID)}`
      if (!completed) {
        await request(
          'POST',
          `${path}/${v2 ? 'interrupt' : 'abort'}`,
          undefined,
          AbortSignal.timeout(2_000)
        ).catch(() => console.warn('OpenCode text task interruption cleanup failed'))
      }
      await request('DELETE', path, undefined, AbortSignal.timeout(2_000)).catch(() =>
        console.warn('OpenCode text task session cleanup failed')
      )
    }
  }
}
