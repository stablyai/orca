import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as z from 'zod'
import {
  schemas,
  type DingTalkGroupId,
  type DingTalkMessageId,
  type DingTalkProfile
} from '../dingtalk-domain'

const Event = z.object({
  type: z.enum(['user_im_message_receive_at', 'user_im_message_receive_group']),
  message_id: z.string().optional(),
  event_id: z.string().optional(),
  conversation_id: z.string().min(1),
  sender: z.string().default('未知'),
  sender_open_dingtalk_id: z.string().min(1),
  content: z.string().default(''),
  create_time: z.unknown().optional()
})

export type DwsEvent = {
  source: 'at' | 'group'
  profile: DingTalkProfile
  groupId: DingTalkGroupId
  conversationId: string
  messageId: DingTalkMessageId
  senderOpenId: string
  senderName: string
  content: string
  createTime: string
}

export type DwsSendOutcome =
  | { kind: 'sent'; taskId: string }
  | { kind: 'not-started'; error: string }
  | { kind: 'uncertain'; error: string }

export type DwsConsumer = { stop: () => Promise<void> }

type Run = {
  code: number | null
  stdout: string
  stderr: string
  notStarted: boolean
  timedOut: boolean
}

export class DwsBoundary {
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  constructor(
    private readonly path: () => string,
    private readonly timeoutMs = 60_000
  ) {}

  private env(): NodeJS.ProcessEnv {
    const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    const current = (process.env.PATH ?? '').split(delimiter)
    return { ...process.env, PATH: [...new Set([...current, ...extra])].join(delimiter) }
  }

  async send(
    profile: DingTalkProfile,
    groupId: DingTalkGroupId,
    text: string,
    uuid: string
  ): Promise<DwsSendOutcome> {
    const run = await this.run(profile, [
      'chat',
      'message',
      'send',
      '--group',
      groupId,
      '--text',
      text,
      '--uuid',
      uuid
    ])
    if (run.notStarted) {
      return { kind: 'not-started', error: run.stderr }
    }
    if (run.timedOut || run.code !== 0) {
      return { kind: 'uncertain', error: run.timedOut ? 'dws send timed out' : run.stderr }
    }
    try {
      const parsed: unknown = JSON.parse(run.stdout.trim())
      const answer = z
        .object({ success: z.boolean().optional(), openTaskId: z.string().optional() })
        .passthrough()
        .parse(parsed)
      if (answer.success !== true && !answer.openTaskId) {
        return { kind: 'uncertain', error: 'dws did not confirm send' }
      }
      return { kind: 'sent', taskId: answer.openTaskId ?? '' }
    } catch (error) {
      return { kind: 'uncertain', error: error instanceof Error ? error.message : String(error) }
    }
  }

  consume(
    profile: DingTalkProfile,
    source: { kind: 'at' } | { kind: 'group'; groupId: DingTalkGroupId },
    onEvent: (event: DwsEvent) => void
  ): DwsConsumer {
    const args = [
      '--profile',
      profile,
      'event',
      'consume',
      source.kind === 'at' ? 'user_im_message_receive_at' : 'user_im_message_receive_group',
      '--flatten',
      '--format',
      'ndjson',
      '--ephemeral'
    ]
    if (source.kind === 'group') {
      args.push('--group', source.groupId)
    }
    let child: ChildProcessWithoutNullStreams | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let failures = 0
    const launch = (): void => {
      if (stopped) {
        return
      }
      try {
        child = spawn(this.path(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env() })
      } catch {
        schedule()
        return
      }
      const current = child
      this.children.add(current)
      createInterface({ input: current.stdout }).on('line', (line) => {
        const parsed = Event.safeParse(parseJson(line))
        if (!parsed.success) {
          return
        }
        const value = parsed.data
        const messageId = value.message_id ?? value.event_id
        if (!messageId) {
          return
        }
        const sourceKind = value.type === 'user_im_message_receive_at' ? 'at' : 'group'
        onEvent({
          source: sourceKind,
          profile,
          groupId: schemas.GroupId.parse(value.conversation_id),
          conversationId: value.conversation_id,
          messageId: schemas.MessageId.parse(messageId),
          senderOpenId: value.sender_open_dingtalk_id,
          senderName: value.sender,
          content: value.content,
          createTime: normalizeCreateTime(value.create_time)
        })
      })
      current.once('error', () => schedule())
      current.once('close', () => {
        this.children.delete(current)
        if (child === current) {
          child = null
        }
        if (!stopped) {
          schedule()
        }
      })
    }
    const schedule = (): void => {
      if (stopped || retry) {
        return
      }
      const delay = Math.min(1_000 * 2 ** Math.min(failures, 5), 30_000)
      failures += 1
      retry = setTimeout(() => {
        retry = null
        launch()
      }, delay)
      retry.unref?.()
    }
    launch()
    return {
      stop: async () => {
        stopped = true
        if (retry) {
          clearTimeout(retry)
          retry = null
        }
        const active = child
        if (!active) {
          return
        }
        active.stdin.end()
        await new Promise<void>((resolve) => active.once('close', resolve))
        this.children.delete(active)
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.children].map(async (child) => {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => child.once('close', () => resolve()))
      })
    )
    this.children.clear()
  }

  private run(profile: DingTalkProfile, args: readonly string[]): Promise<Run> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(this.path(), ['--profile', profile, ...args, '--format', 'json'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env()
        })
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          notStarted: true,
          timedOut: false
        })
        return
      }
      this.children.add(child)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, this.timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr = stderr.slice(-8000) + String(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.children.delete(child)
        resolve({
          code: null,
          stdout,
          stderr: error.message,
          notStarted: true,
          timedOut
        })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.children.delete(child)
        resolve({ code, stdout, stderr, notStarted: false, timedOut })
      })
    })
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function normalizeCreateTime(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value)
    return date.toISOString().slice(0, 19).replace('T', ' ')
  }
  return ''
}
