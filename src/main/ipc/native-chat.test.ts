import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    })
  }
}))

import {
  clearNativeChatSubscriptions,
  clearNativeChatTranscriptCache,
  registerNativeChatHandlers
} from './native-chat'

let tempRoots: string[] = []

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  clearNativeChatTranscriptCache()
  clearNativeChatSubscriptions()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function invokeReadSession(args: {
  agent: string
  sessionId: string
  limit?: number
}): Promise<unknown> {
  registerNativeChatHandlers()
  const handler = handlers.get('nativeChat:readSession')
  if (!handler) {
    throw new Error('handler not registered')
  }
  return handler({}, args)
}

describe('nativeChat:readSession handler', () => {
  it('resolves a Claude transcript and returns the full conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-'))
    tempRoots.push(root)
    const projectsDir = join(root, '.claude', 'projects')
    const projectDir = join(projectsDir, '-repo')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'sess-ipc.jsonl'),
      jsonLines([
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'Hi' }
        },
        {
          type: 'assistant',
          uuid: 'a-1',
          timestamp: '2026-06-01T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
        }
      ])
    )

    // Point homedir-derived Claude root at our fixture via HOME so the resolver
    // (which reads homedir() internally) finds the transcript.
    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      const result = (await invokeReadSession({ agent: 'claude', sessionId: 'sess-ipc' })) as {
        messages?: unknown[]
        error?: string
      }
      expect(result.error).toBeUndefined()
      expect(result.messages).toHaveLength(2)
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('windows to the most-recent `limit` turns and pages older history when raised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-limit-'))
    tempRoots.push(root)
    const projectDir = join(root, '.claude', 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    // Five user turns; reading with limit 2 returns only the last two, and a
    // larger limit pages in older ones (chronological order preserved).
    const records = [1, 2, 3, 4, 5].map((n) => ({
      type: 'user',
      uuid: `u-${n}`,
      timestamp: `2026-06-01T10:00:0${n}.000Z`,
      message: { role: 'user', content: `m${n}` }
    }))
    await writeFile(join(projectDir, 'sess-limit.jsonl'), jsonLines(records))

    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      const windowed = (await invokeReadSession({
        agent: 'claude',
        sessionId: 'sess-limit',
        limit: 2
      })) as { messages: { id: string }[] }
      expect(windowed.messages.map((m) => m.id)).toEqual(['u-4', 'u-5'])

      const wider = (await invokeReadSession({
        agent: 'claude',
        sessionId: 'sess-limit',
        limit: 4
      })) as { messages: { id: string }[] }
      expect(wider.messages.map((m) => m.id)).toEqual(['u-2', 'u-3', 'u-4', 'u-5'])
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('emits appended messages over nativeChat:appended and tears down on destroy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-sub-'))
    tempRoots.push(root)
    const projectsDir = join(root, '.claude', 'projects')
    const projectDir = join(projectsDir, '-repo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-sub.jsonl')
    await writeFile(
      filePath,
      `${jsonLines([
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'Hi' }
        }
      ])}\n`
    )

    registerNativeChatHandlers()
    const subscribe = listeners.get('nativeChat:subscribe')
    expect(subscribe).toBeDefined()

    const sent: { channel: string; payload: unknown }[] = []
    let destroyedCb: (() => void) | undefined
    const sender = {
      id: 1,
      isDestroyed: () => false,
      once: (event: string, cb: () => void) => {
        if (event === 'destroyed') {
          destroyedCb = cb
        }
      },
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }

    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      subscribe!(
        { sender },
        {
          subscriptionId: 'sub-1',
          agent: 'claude',
          sessionId: 'sess-sub'
        }
      )

      // The listener dispatches handleSubscribe fire-and-forget; give it a beat
      // to resolve the path and install the watcher before we append.
      await new Promise((resolve) => setTimeout(resolve, 100))

      await appendFile(
        filePath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'a-1',
          timestamp: '2026-06-01T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
        })}\n`
      )

      // Seed-at-0 means the first appended event carries the whole-file re-read;
      // the new turn 'a-1' arrives across one of the appended events. Collect ids
      // from every appended event and assert the new turn shows up.
      const appendedIds = (): string[] =>
        sent
          .filter((s) => s.channel === 'nativeChat:appended')
          .flatMap((s) => (s.payload as { messages: { id: string }[] }).messages.map((m) => m.id))
      await waitFor(() => appendedIds().includes('a-1'))
      const appendedEvent = sent.find((s) => s.channel === 'nativeChat:appended')!
      const payload = appendedEvent.payload as { subscriptionId: string }
      expect(payload.subscriptionId).toBe('sub-1')
      expect(appendedIds()).toContain('a-1')

      // Destroyed window tears down the watcher without error.
      expect(destroyedCb).toBeDefined()
      destroyedCb!()
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('returns an error for an unknown session without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-missing-'))
    tempRoots.push(root)
    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      const result = (await invokeReadSession({ agent: 'claude', sessionId: 'nope' })) as {
        error?: string
      }
      expect(result.error).toBeTruthy()
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })
})
