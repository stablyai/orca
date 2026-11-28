/*! @license @larksuiteoapi/node-sdk 1.73.1
 * MIT License
 *
 * Copyright (c) 2022 Lark Technologies Pte. Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice, shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAbortSignal, type Readable } from 'node:stream'
import type { Cache, Client, HttpInstance } from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { sanitizeAgentSessionAttachmentName } from '../../shared/agent-session/agent-session-attachments'
import { FeishuOpenId, type FeishuGroupPolicy } from '../../shared/bots/feishu-local'
import { FEISHU_MESSAGE_EVENT, readFeishuGroupMessage, readFeishuMessage } from './feishu-message'

const quiet = () => {}
const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet }
const REQUEST_TIMEOUT = 20_000

import { FeishuReplyTargetGone, FeishuUploadPermissionError } from './feishu-transport'

import type { FeishuReply, FeishuReplyThread, FeishuTransport } from './feishu-transport'

export async function openFeishuSdk(
  appId: string,
  appSecret: string,
  signal: AbortSignal,
  group?: FeishuGroupPolicy
): Promise<FeishuTransport> {
  const { Client, Domain, EventDispatcher, WSClient, defaultHttpInstance } =
    await import('@larksuiteoapi/node-sdk')
  signal.throwIfAborted()
  const transport = defaultHttpInstance.create({
    signal,
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024
  })
  transport.interceptors.response.use((response) =>
    '$return_headers' in response.config && response.config.$return_headers
      ? { data: response.data, headers: response.headers }
      : response.data
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Axios types describe the response before the SDK's data/header interceptor runs.
  const httpInstance = transport as HttpInstance
  const options = { appId, appSecret, domain: Domain.Feishu, logger, httpInstance, source: 'orca' }
  const cache = new Map<Parameters<Cache['get']>[0], { value: unknown; expiry: number }>()
  const client = new Client({
    ...options,
    cache: {
      async get(key) {
        const entry = cache.get(key)
        return entry && entry.expiry > Date.now() ? entry.value : undefined
      },
      async set(key, value: unknown, expiry = Infinity) {
        cache.set(key, { value, expiry })
        return true
      }
    }
  })

  const listen: FeishuTransport['listen'] = async (ready, reconnecting, receive) => {
    signal.throwIfAborted()
    const botOpenId = group
      ? z
          .object({ code: z.literal(0), bot: z.object({ open_id: FeishuOpenId }) })
          .parse(await client.request<unknown>({ method: 'GET', url: '/open-apis/bot/v3/info' }))
          .bot.open_id
      : null
    const dispatcher = new EventDispatcher({ logger }).register({
      [FEISHU_MESSAGE_EVENT]: async (event: unknown) => {
        const message =
          readFeishuMessage(event, appId) ??
          (group && botOpenId ? readFeishuGroupMessage(event, appId, botOpenId, group) : null)
        if (message && !signal.aborted) {
          await receive(message)
        }
      }
    })
    const lifetime = Promise.withResolvers<void>()
    const stop = () => lifetime.resolve()
    const startup = setTimeout(stop, 45_000).unref()
    const ws = new WSClient({
      ...options,
      autoReconnect: true,
      handshakeTimeoutMs: 10_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => {
        clearTimeout(startup)
        if (!signal.aborted) {
          ready()
        }
      },
      onReconnecting: reconnecting,
      onReconnected: ready,
      onError: stop
    })
    signal.addEventListener('abort', stop, { once: true })
    try {
      await ws.start({ eventDispatcher: dispatcher })
      await lifetime.promise
    } finally {
      clearTimeout(startup)
      signal.removeEventListener('abort', stop)
      ws.close({ force: true })
    }
  }

  return {
    listen,
    async original(mid: string): Promise<unknown> {
      const result = await client.im.v1.message.get({
        path: { message_id: mid },
        params: { user_id_type: 'open_id' }
      })
      if (result.code !== 0) {
        throw new Error('Could not read the original Feishu message')
      }
      return result.data?.items
    },
    async reply(mid, chat, message, uuid, thread) {
      await replyToOriginal(client, mid, chat, message, uuid, thread)
    },
    async upload(name: string, bytes: Uint8Array) {
      const dir = await mkdtemp(join(tmpdir(), 'orca-feishu-'))
      try {
        const path = join(dir, sanitizeAgentSessionAttachmentName(name))
        await writeFile(path, bytes, { mode: 0o600, signal })
        const file = createReadStream(path, { signal })
        const closed = new Promise<void>((resolve) => file.once('close', resolve))
        file.on('error', quiet)
        try {
          // The SDK's multipart encoder gets the file part's filename from the stream path.
          const result = await client.im.v1.file.create({
            data: { file_type: 'stream', file_name: name, file }
          })
          return z.object({ file_key: z.string().regex(/^file_[a-zA-Z0-9_-]+$/) }).parse(result)
            .file_key
        } catch (error) {
          const code = z
            .object({ response: z.object({ data: z.object({ code: z.number() }) }) })
            .safeParse(error).data?.response.data.code
          if (code === 99991672) {
            throw new FeishuUploadPermissionError()
          }
          throw new Error('Feishu file upload failed')
        } finally {
          file.destroy()
          await closed
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    async download(mid: string, key: string, kind: 'image' | 'file', limit: number) {
      const result = await client.im.v1.messageResource.get({
        path: { message_id: mid, file_key: key },
        params: { type: kind }
      })
      const input: Readable = result.getReadableStream()
      const chunks: Buffer[] = []
      let size = 0
      try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        for await (const chunk of addAbortSignal(deadline, input)) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.length
          if (size > limit) {
            throw new Error('Unsupported Feishu attachment size')
          }
          chunks.push(bytes)
        }
        deadline.throwIfAborted()
        return Buffer.concat(chunks, size)
      } finally {
        input.destroy()
      }
    }
  }
}

function replyTargetGone(code: unknown): boolean {
  return code === 230011 || code === 230019 || code === 230110
}

async function replyToOriginal(
  client: Client,
  mid: string,
  chat: string,
  message: FeishuReply,
  uuid: string,
  thread?: FeishuReplyThread
) {
  let result: Awaited<ReturnType<Client['im']['v1']['message']['reply']>>
  try {
    result = await client.im.v1.message.reply({
      path: { message_id: mid },
      data: {
        msg_type: message.type,
        content: JSON.stringify(message.content),
        uuid,
        ...(thread?.inThread ? { reply_in_thread: true } : {})
      }
    })
  } catch (error) {
    const code = z
      .object({ response: z.object({ data: z.object({ code: z.number() }) }) })
      .safeParse(error).data?.response.data.code
    if (replyTargetGone(code)) {
      throw new FeishuReplyTargetGone('The Feishu reply target is unavailable')
    }
    throw new Error('Feishu reply failed')
  }
  if (replyTargetGone(result.code)) {
    throw new FeishuReplyTargetGone('The Feishu reply target is unavailable')
  }
  // Feishu reports the topic root as parent for replies within a topic.
  const parent = result.data?.parent_id
  if (
    result.code !== 0 ||
    result.data?.chat_id !== chat ||
    (parent && parent !== mid && parent !== thread?.rootId) ||
    (thread && result.data?.root_id && result.data.root_id !== thread.rootId) ||
    !/^om_[a-zA-Z0-9_-]+$/.test(result.data?.message_id ?? '')
  ) {
    throw new Error('Could not verify the Feishu reply')
  }
}
