import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  genAiEventsFromOpenAiSse,
  genAiSseFromOpenAiChunks,
  openAiMessagesFromGenAi,
  openAiToolsFromGenAi,
  OpenAiStreamToGenAi
} from './genai-openai-conversion.mjs'
import { mintGatewayCredential } from './gateway-credential-broker.mjs'

export class GatewayProtocolError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const LOOPBACK_AUTH_HEADER = 'x-orca-acp-loopback-auth'

function authorizedLoopback(request, credential) {
  const supplied = request.headers[LOOPBACK_AUTH_HEADER]
  if (typeof supplied !== 'string') {
    return false
  }
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(credential)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function redact(message, token) {
  return String(message)
    .replaceAll(token ?? '', '<redacted>')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <redacted>')
    .replace(/Received=[^\s,\\"]+/g, 'Received=<redacted>')
    .replace(/https?:\/\/[^\s"',}]+/gi, '<redacted-url>')
    .replace(/eyJ[A-Za-z0-9_*.-]+/g, '<redacted-token>')
    .slice(0, 256)
}

async function requestBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 1_048_576) {
      throw new GatewayProtocolError(413, 'External ACP request is too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function generationModel(path, profile) {
  const match = /^\/(.+\/models)\/([^/:]+):streamGenerateContent$/.exec(path)
  if (!match) {
    return null
  }
  const id = decodeURIComponent(match[2])
  if (profile.modelIds.includes(id)) {
    return id
  }
  const [alias] = profile.modelIds
    .filter((model) => id.startsWith(`${model}-`))
    .sort((left, right) => right.length - left.length)
  if (!alias) {
    throw new GatewayProtocolError(404, 'External ACP model is not in the registered profile')
  }
  return alias
}

function toolChoice(input) {
  const mode = input.toolConfig?.functionCallingConfig?.mode?.toLowerCase()
  return mode === 'any'
    ? 'required'
    : mode === 'none'
      ? 'none'
      : mode === 'auto'
        ? 'auto'
        : undefined
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new Error('External ACP turn was canceled'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('External ACP turn was canceled'))
      },
      { once: true }
    )
  })
}

async function fetchOpenAi(profile, token, input, signal, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response
    try {
      const timeout = AbortSignal.timeout(profile.timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const body = {
        model: generationModel(input.path, profile),
        messages: openAiMessagesFromGenAi(input.body),
        stream: true,
        tools: openAiToolsFromGenAi(input.body.tools),
        tool_choice: toolChoice(input.body),
        ...(input.body.generationConfig?.maxOutputTokens
          ? { max_tokens: input.body.generationConfig.maxOutputTokens }
          : {})
      }
      response = await fetchImpl(profile.openAiChatUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined
      })
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      if (attempt === 0) {
        await abortableDelay(0, signal)
        continue
      }
      throw new GatewayProtocolError(504, 'External ACP upstream timed out')
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await response.arrayBuffer().catch(() => undefined)
      await abortableDelay(0, signal)
      continue
    }
    return response
  }
  throw new GatewayProtocolError(500, 'External ACP upstream did not complete')
}

async function readBody(request) {
  const text = await requestBody(request)
  try {
    return JSON.parse(text)
  } catch {
    throw new GatewayProtocolError(400, 'External ACP request is not valid GenAI JSON')
  }
}

const MAX_SSE_EVENT_BYTES = 1_048_576

async function* openAiEventStream(upstream) {
  if (!upstream.body) {
    throw new GatewayProtocolError(502, 'External ACP upstream returned no body')
  }
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      pending += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(pending)
        if (!boundary) {
          break
        }
        const length = boundary.index + boundary[0].length
        const raw = pending.slice(0, length)
        pending = pending.slice(length)
        if (Buffer.byteLength(raw) > MAX_SSE_EVENT_BYTES) {
          throw new GatewayProtocolError(502, 'External ACP upstream event is too large')
        }
        yield* genAiEventsFromOpenAiSse(raw)
      }
      if (Buffer.byteLength(pending) > MAX_SSE_EVENT_BYTES) {
        throw new GatewayProtocolError(502, 'External ACP upstream event is too large')
      }
    }
    pending += decoder.decode()
    if (pending.trim()) {
      yield* genAiEventsFromOpenAiSse(pending)
    }
  } catch (error) {
    if (error instanceof GatewayProtocolError) {
      throw error
    }
    throw new GatewayProtocolError(502, 'External ACP upstream returned invalid event data')
  } finally {
    reader.releaseLock()
  }
}

async function writeGenAiChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) {
    return false
  }
  if (!response.headersSent) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  }
  if (response.write(genAiSseFromOpenAiChunks([chunk]))) {
    return true
  }
  return new Promise((resolve) => {
    const finish = () => {
      response.removeListener('drain', finish)
      response.removeListener('close', finish)
      response.removeListener('error', finish)
      response.removeListener('finish', finish)
      resolve(!response.destroyed)
    }
    response.once('drain', finish)
    response.once('close', finish)
    response.once('error', finish)
    response.once('finish', finish)
  })
}

function streamError(response, status, message) {
  if (response.destroyed || response.writableEnded) {
    return
  }
  response.end(
    `data: ${JSON.stringify({ error: { code: status, message, status: 'UNKNOWN' } })}\r\n\r\n`
  )
}

function write(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

export async function startExternalGatewayBridge(profile, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const token = await (options.getToken?.() ?? mintGatewayCredential(profile))
  const loopbackCredential = options.loopbackTokenOverride ?? randomBytes(32).toString('base64url')
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('No gateway credential is available from the per-profile handoff')
  }
  const requestControllers = new Set()
  let closed = false
  const server = createServer(async (request, response) => {
    if (closed) {
      return
    }
    if (!authorizedLoopback(request, loopbackCredential)) {
      write(response, 401, { error: 'External ACP loopback authentication failed' })
      return
    }
    const controller = new AbortController()
    requestControllers.add(controller)
    const finish = () => requestControllers.delete(controller)
    let completed = false
    request.on('aborted', () => controller.abort())
    response.on('close', () => {
      if (!completed) {
        controller.abort()
      }
    })
    try {
      if (request.method !== 'POST' || request.url === undefined) {
        throw new GatewayProtocolError(404, 'External ACP endpoint is not found')
      }
      const path = new URL(request.url, 'http://loopback.invalid').pathname
      generationModel(path, profile)
      const input = { path, body: await readBody(request) }
      const upstream = await fetchOpenAi(profile, token, input, controller.signal, fetchImpl)
      if (!upstream.ok) {
        const status = upstream.status
        await upstream.body?.cancel().catch(() => undefined)
        write(response, status, { error: `External ACP upstream returned HTTP ${status}` })
        return
      }
      const converter = new OpenAiStreamToGenAi()
      let chunks = 0
      for await (const event of openAiEventStream(upstream)) {
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
          throw new GatewayProtocolError(502, 'External ACP upstream returned an invalid response')
        }
        for (const chunk of converter.accept(event)) {
          if (!(await writeGenAiChunk(response, chunk))) {
            return
          }
          chunks += 1
        }
      }
      if (chunks === 0) {
        throw new GatewayProtocolError(502, 'External ACP upstream returned no usable content')
      }
      if (!response.destroyed && !response.writableEnded) {
        response.end()
      }
    } catch (error) {
      const status = error instanceof GatewayProtocolError ? error.status : 504
      const message =
        error instanceof Error && !(error instanceof GatewayProtocolError)
          ? controller.signal.aborted
            ? 'External ACP turn was canceled'
            : 'External ACP upstream did not complete'
          : redact(error instanceof Error ? error.message : error, token)
      if (response.headersSent) {
        streamError(response, status, message)
      } else {
        write(response, status, { error: message })
      }
    } finally {
      completed = true
      finish()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('External ACP adapter could not bind a loopback listener')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}${profile.gatewayBaseUrl}`,
    headers: { [LOOPBACK_AUTH_HEADER]: loopbackCredential },
    abortPending: () => {
      for (const controller of requestControllers) {
        controller.abort()
      }
    },
    close: () => {
      if (closed) {
        return Promise.resolve()
      }
      closed = true
      for (const controller of requestControllers) {
        controller.abort()
      }
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
