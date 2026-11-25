import { runProcess, spawnProcess } from '@orca/process-host'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import type { Readable } from 'node:stream'
import { z } from 'zod'

import { feishuDiagnostic, feishuProblem, FeishuHostError } from './feishu-cli-status'

const EVENT = 'im.message.receive_v1'
const appId = z.string().regex(/^cli_[a-zA-Z0-9]+$/)
const openId = z.string().regex(/^ou_[a-zA-Z0-9_-]{1,120}$/)
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]{1,120}$/)
const chatId = z.string().regex(/^oc_[a-zA-Z0-9_-]{1,120}$/)
const profile = z.object({ name: z.string().min(1).max(128), appId: z.string(), brand: z.string() })
export type FeishuProfile = z.infer<typeof profile>
const message = z.object({
  type: z.literal(EVENT),
  chat_type: z.literal('p2p'),
  message_type: z.enum(['text', 'image', 'file']),
  create_time: z.string().regex(/^\d{13}$/),
  event_id: z.string().min(1).max(256),
  message_id: messageId,
  chat_id: chatId,
  sender_id: openId,
  content: z
    .string()
    .min(1)
    .max(64 * 1024)
    .refine((s) => s.trim().length > 0 && !s.includes('\0'))
})
export type FeishuMessage = z.infer<typeof message>
export function readFeishuMessage(line: string): FeishuMessage | null {
  try {
    return message.safeParse(JSON.parse(line)).data ?? null
  } catch {
    return null
  }
}

/** A recalled original or a missing topic cannot accept another reply. */
export class FeishuReplyTargetGone extends Error {}

export async function feishuCommand(
  args: string[],
  signal?: AbortSignal,
  input?: string | Uint8Array
): Promise<unknown> {
  const result = await runProcess({
    program: 'lark-cli',
    detached: process.platform !== 'win32',
    args,
    input,
    signal,
    maxOutputBytes: 512 * 1024,
    timeoutMs: 20_000
  })
  if (result.code !== 0 || result.outputTruncated || signal?.aborted) {
    if (!signal?.aborted && !result.outputTruncated && result.code !== 0) {
      let diagnostic: unknown
      try {
        diagnostic = JSON.parse(result.stderr)
      } catch {
        // Unstructured CLI failures stay retryable.
      }
      const code = z
        .object({ ok: z.literal(false), error: z.object({ code: z.number() }) })
        .safeParse(diagnostic).data?.error.code
      if (code === 230011 || code === 230019 || code === 230110) {
        throw new FeishuReplyTargetGone('The Feishu reply target is unavailable')
      }
    }
    throw new Error('Feishu CLI command failed')
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('Feishu CLI returned invalid JSON')
  }
}

/** By app ID the CLI picks the first matching profile, unless a profile name shadows that ID. */
export function eligibleProfiles(value: unknown): FeishuProfile[] {
  const result = z.array(profile).safeParse(value)
  if (!result.success) {
    throw new Error('Feishu CLI returned invalid profiles')
  }
  const all = result.data
  return all.filter(
    (p) =>
      p.brand === 'feishu' &&
      appId.safeParse(p.appId).success &&
      all.find((other) => other.appId === p.appId) === p &&
      !all.some(
        (other) =>
          other !== p &&
          (other.name === p.name ||
            other.name === p.appId ||
            (other.appId === p.appId && other.brand !== p.brand))
      )
  )
}
export async function listProfiles(signal?: AbortSignal): Promise<FeishuProfile[]> {
  try {
    return eligibleProfiles(await feishuCommand(['profile', 'list'], signal))
  } catch (error) {
    throw new FeishuHostError(feishuProblem(error))
  }
}

/** Never accumulate an unbounded partial line from either pipe. */
async function readLines(
  stream: Readable,
  receive: (line: string) => void | Promise<void>
): Promise<void> {
  stream.setEncoding('utf8')
  let carry = ''
  let skip = false
  for await (const chunk of stream) {
    const parts = String(chunk).split('\n')
    for (const [i, part] of parts.entries()) {
      if (!skip && carry.length + part.length <= 512 * 1024) {
        carry += part
      } else {
        carry = ''
        skip = true
      }
      if (i < parts.length - 1) {
        if (!skip) {
          await receive(carry.trimEnd())
        }
        carry = ''
        skip = false
      }
    }
  }
}

export async function consumeFeishu(
  app: string,
  signal: AbortSignal,
  ready: () => void,
  receive: (m: FeishuMessage) => Promise<void>
): Promise<void> {
  signal.throwIfAborted()
  const child = spawnProcess({
    program: 'lark-cli',
    args: ['--profile', app, 'event', 'consume', EVENT, '--as', 'bot'],
    stdio: 'pipe',
    detached: process.platform !== 'win32'
  })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => resolve())
  })
  let kill: NodeJS.Timeout | undefined
  let force: NodeJS.Timeout | undefined
  child.stdin.on('error', () => {})
  const stop = (): void => {
    child.stdin.end()
    // EOF releases this subscription. The CLI owns its shared bus and its idle timeout.
    kill ??= setTimeout(() => {
      void signalProcessTree(child, 'SIGTERM')
    }, 1500).unref()
    force ??= setTimeout(() => {
      void signalProcessTree(child, 'SIGKILL')
    }, 3500).unref()
  }
  signal.addEventListener('abort', stop, { once: true })
  const startup = setTimeout(stop, 60_000).unref()
  let diagnostic = ''
  try {
    await Promise.all([
      closed,
      readLines(child.stderr, (line) => {
        if (line === `[event] ready event_key=${EVENT}` && !signal.aborted) {
          clearTimeout(startup)
          ready()
        } else if (line.startsWith('{')) {
          diagnostic = line.slice(0, 8192)
        } else if (diagnostic && diagnostic.length + line.length < 8192) {
          diagnostic += line
        }
      }),
      readLines(child.stdout, async (line) => {
        const parsed = readFeishuMessage(line)
        if (parsed && !signal.aborted) {
          await receive(parsed)
        }
      })
    ])
    if (!signal.aborted) {
      throw new FeishuHostError(feishuDiagnostic(diagnostic))
    }
  } finally {
    signal.removeEventListener('abort', stop)
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      stop()
    }
    await closed.catch(() => {})
    clearTimeout(startup)
    clearTimeout(kill)
    clearTimeout(force)
  }
}

/** Confirm a pairing DM came from a human. The flattened event omits sender_type. */
export async function humanSentPairing(
  app: string,
  m: FeishuMessage,
  signal: AbortSignal
): Promise<boolean> {
  const response = await feishuCommand(
    [
      '--profile',
      app,
      'api',
      'GET',
      `/open-apis/im/v1/messages/${m.message_id}`,
      '--as',
      'bot',
      '--params',
      '{"user_id_type":"open_id"}'
    ],
    signal
  )
  const item = z.object({
    message_id: z.literal(m.message_id),
    chat_id: z.literal(m.chat_id),
    msg_type: z.literal('text'),
    body: z.object({
      content: z.string().refine((raw) => {
        try {
          return JSON.parse(raw)?.text === m.content
        } catch {
          return false
        }
      })
    }),
    sender: z.object({
      sender_type: z.literal('user'),
      id: z.literal(m.sender_id),
      id_type: z.literal('open_id')
    })
  })
  return z
    .object({
      ok: z.literal(true),
      identity: z.literal('bot'),
      data: z.object({ items: z.tuple([item]) })
    })
    .safeParse(response).success
}
