import { openCodeTextTaskEvents } from './opencode-text-task-events'
import {
  OPEN_CODE_LEGACY_TEXT_TASK_TOOLS,
  prepareOpenCodeTextTaskPolicy
} from './opencode-text-task-policy'
import { randomBytes } from 'node:crypto'
import { openCodeTextTaskTarget } from './opencode-text-task-target'
import type { TextGenerationOperation } from '../text-generation/source-control-text-generation-types'
import { createOpenCodeTextTaskHttp } from './opencode-text-task-http'
import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { OpenCodeTextTaskInput } from './opencode-text-task-input'

export type OpenCodeTextTaskSession = {
  version: 'v1' | 'v2'
  v1SessionPolicyFiltersTools: boolean
  url: string
  password?: string
  username?: string
  exclusiveServer?: boolean
  operation?: TextGenerationOperation
  shouldExecute?: () => boolean
  sessionId?: string
  continue?: boolean
  fork?: boolean
  share?: boolean
  external?: OpenCodeTextTaskInput['external']
  externalDirectory?: string
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

const reply = z.looseObject({
  info: z.looseObject({
    id: z.string().optional(),
    error: z.unknown().optional(),
    parentID: z.string().optional()
  }),
  parts: z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))
})

let messageTimestamp = 0
let messageCounter = 0
function nextMessageID(): string {
  const now = Date.now()
  messageCounter = now === messageTimestamp ? messageCounter + 1 : 1
  messageTimestamp = now
  const time = BigInt.asUintN(48, BigInt(now) * 4096n + BigInt(messageCounter))
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const suffix = Array.from(randomBytes(14), (byte) => alphabet[byte % 62]).join('')
  return `msg_${time.toString(16).padStart(12, '0')}${suffix}`
}

/** Task IDs, history and servers have distinct owners; policy precedes semantic input. */
export async function runOpenCodeTextTaskSession(input: OpenCodeTextTaskSession): Promise<string> {
  const v2 = input.version === 'v2'
  const base = v2 ? '/api/session' : '/session'
  let directory = input.directory
  const initialHttp = createOpenCodeTextTaskHttp(
    input.url,
    input.password,
    '',
    input.username,
    input.version
  )
  let http = initialHttp
  const request: typeof http.request = (...args) => http.request(...args)
  const checkCurrent = () => {
    input.signal.throwIfAborted()
    if (input.shouldExecute?.() === false) {
      throw new Error('OpenCode naming task was superseded')
    }
  }
  const messageID = nextMessageID()
  const lost = new AbortController()
  const activeSignal = AbortSignal.any([input.signal, lost.signal])
  let sessionID = ''
  let completed = false
  let owned = false
  let actualSubtask = false
  let submitted = false
  let admission: Promise<unknown> | undefined
  const ownedTree = new Set<string>()
  const events = openCodeTextTaskEvents({
    version: input.version,
    url: input.url,
    signal: input.signal,
    lost,
    messageID,
    context: () => ({ sessionID, owned, ownedTree, directory, http })
  })
  try {
    input.signal.throwIfAborted()
    if (v2) {
      await events.subscribe()
    }
    activeSignal.throwIfAborted()
    let agent = input.agent || undefined
    const target = await openCodeTextTaskTarget({
      task: input,
      version: input.version,
      directory,
      http: initialHttp,
      signal: activeSignal,
      allocated: (id, taskDirectory) => {
        sessionID = id
        directory = taskDirectory
        owned = true
        ownedTree.add(id)
        http = createOpenCodeTextTaskHttp(
          input.url,
          input.password,
          v2 ? '' : `?directory=${encodeURIComponent(directory)}`,
          input.username,
          input.version
        )
      },
      prepare: async (taskDirectory) => {
        directory = taskDirectory
        http = createOpenCodeTextTaskHttp(
          input.url,
          input.password,
          v2 ? '' : `?directory=${encodeURIComponent(directory)}`,
          input.username,
          input.version
        )
        const prepared = await prepareOpenCodeTextTaskPolicy(input, http, activeSignal)
        agent = prepared.agent
        actualSubtask = prepared.actualSubtask
        return prepared
      }
    })
    sessionID = target.id
    directory = target.directory
    owned = target.owned
    activeSignal.throwIfAborted()
    const legacyPolicy = !v2 && owned && !target.policyAcknowledged
    if (!v2 && owned && (actualSubtask || legacyPolicy || !input.v1SessionPolicyFiltersTools)) {
      await events.subscribe()
    }
    if (input.share) {
      await request(
        'POST',
        `${base}/${encodeURIComponent(sessionID)}/share`,
        undefined,
        activeSignal
      ).catch(() => {})
      activeSignal.throwIfAborted()
    }
    let text: string
    if (v2) {
      if (input.agent && (!owned || input.fork)) {
        await request(
          'POST',
          `${base}/${encodeURIComponent(sessionID)}/agent`,
          { agent: input.agent },
          activeSignal
        )
      }
      let selectedModel = input.model
        ? {
            providerID: input.model.providerID,
            id: input.model.modelID,
            ...(input.variant ? { variant: input.variant } : {})
          }
        : undefined
      if (!selectedModel && input.variant) {
        const current = z
          .looseObject({
            model: z
              .looseObject({
                providerID: z.string(),
                id: z.string(),
                variant: z.string().optional()
              })
              .optional()
          })
          .parse(
            await request(
              'GET',
              `${base}/${encodeURIComponent(sessionID)}`,
              undefined,
              activeSignal
            )
          )
        const model =
          current.model ??
          z
            .looseObject({ providerID: z.string(), id: z.string() })
            .parse(await request('GET', '/api/model/default', undefined, activeSignal))
        selectedModel = { ...model, variant: input.variant }
      }
      if (selectedModel && (!owned || input.fork || !input.model)) {
        await request(
          'POST',
          `${base}/${encodeURIComponent(sessionID)}/model`,
          { model: selectedModel },
          activeSignal
        )
      }
      checkCurrent()
      submitted = true
      admission = request(
        'POST',
        `${base}/${encodeURIComponent(sessionID)}/prompt`,
        {
          id: messageID,
          delivery: 'steer',
          text: input.prompt,
          ...(input.v2Files?.length ? { files: input.v2Files } : {})
        },
        AbortSignal.timeout(10_000)
      )
      await waitForPromiseWithSignal(admission, activeSignal)
      text = await waitForPromiseWithSignal(events.completion, activeSignal)
    } else {
      checkCurrent()
      const result = reply.parse(
        await request(
          'POST',
          `${base}/${encodeURIComponent(sessionID)}/${input.command ? 'command' : 'message'}`,
          {
            messageID,
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
              : {
                  parts: [...(input.v1Files ?? []), { type: 'text', text: input.prompt }],
                  ...(legacyPolicy ? { tools: OPEN_CODE_LEGACY_TEXT_TASK_TOOLS } : {})
                })
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
    await events.close()
    if (sessionID) {
      const path = `${base}/${encodeURIComponent(sessionID)}`
      if (!completed && (owned || input.exclusiveServer !== false)) {
        await request(
          'POST',
          `${path}/${v2 ? 'interrupt' : 'abort'}`,
          undefined,
          AbortSignal.timeout(2_000)
        ).catch(() => console.warn('OpenCode text task interruption cleanup failed'))
      }
      if (!owned && input.exclusiveServer === false && v2 && submitted && !events.promoted) {
        await admission?.catch(() => {})
        await request(
          'DELETE',
          `${path}/inbox/${encodeURIComponent(messageID)}`,
          undefined,
          AbortSignal.timeout(2_000)
        ).catch(() => console.warn('OpenCode naming input cancellation failed'))
      }
      if (owned && !input.share) {
        await request('DELETE', path, undefined, AbortSignal.timeout(2_000)).catch(() =>
          console.warn('OpenCode text task session cleanup failed')
        )
      }
    }
  }
}
