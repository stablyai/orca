import { createServer } from 'node:http'
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
  if (!profile.modelIds.some((model) => id === model || id.startsWith(`${model}-`))) {
    throw new GatewayProtocolError(404, 'External ACP model is not in the registered profile')
  }
  return profile.modelIds.find((model) => id === model || id.startsWith(`${model}-`))
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

function write(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

export async function startExternalGatewayBridge(profile, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const token = await (options.getToken?.() ?? mintGatewayCredential(profile))
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('No gateway credential is available from the per-profile handoff')
  }
  const requestControllers = new Set()
  let closed = false
  const server = createServer(async (request, response) => {
    if (closed) {
      return
    }
    const controller = new AbortController()
    requestControllers.add(controller)
    const finish = () => requestControllers.delete(controller)
    request.on('aborted', () => controller.abort())
    try {
      if (request.method !== 'POST' || request.url === undefined) {
        throw new GatewayProtocolError(404, 'External ACP endpoint is not found')
      }
      const path = new URL(request.url, 'http://loopback.invalid').pathname
      generationModel(path, profile)
      const input = { path, body: await readBody(request) }
      const upstream = await fetchOpenAi(profile, token, input, controller.signal, fetchImpl)
      const raw = await upstream.text()
      if (!upstream.ok) {
        const status = upstream.status
        write(response, status, { error: `External ACP upstream returned HTTP ${status}` })
        return
      }
      let events
      try {
        events = genAiEventsFromOpenAiSse(raw)
      } catch {
        throw new GatewayProtocolError(502, 'External ACP upstream returned invalid event data')
      }
      const converter = new OpenAiStreamToGenAi()
      const chunks = []
      for (const event of events) {
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
          throw new GatewayProtocolError(502, 'External ACP upstream returned an invalid response')
        }
        chunks.push(...converter.accept(event))
      }
      if (chunks.length === 0) {
        throw new GatewayProtocolError(502, 'External ACP upstream returned no usable content')
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(genAiSseFromOpenAiChunks(chunks))
    } catch (error) {
      const status = error instanceof GatewayProtocolError ? error.status : 504
      write(response, status, {
        error:
          error instanceof Error && !(error instanceof GatewayProtocolError)
            ? controller.signal.aborted
              ? 'External ACP turn was canceled'
              : 'External ACP upstream did not complete'
            : redact(error instanceof Error ? error.message : error, token)
      })
    } finally {
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
