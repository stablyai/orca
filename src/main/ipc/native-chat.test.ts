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
  _getNativeChatSenderCleanupCountForTest,
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

async function invokeReadSession(
  args: {
    agent: string
    sessionId: string
    limit?: number
    transcriptPath?: string
    ptyId?: string
  },
  deps?: Parameters<typeof registerNativeChatHandlers>[0]
): Promise<unknown> {
  registerNativeChatHandlers(deps)
  const handler = handlers.get('nativeChat:readSession')
  if (!handler) {
    throw new Error('handler not registered')
  }
  return handler({}, args)
}

describe('nativeChat:readSession handler', () => {
  it('asks the PTY owner for transcript provenance', async () => {
    const resolveTranscriptHost = vi.fn(() => ({ kind: 'host' as const }))

    await invokeReadSession(
      { agent: 'claude', sessionId: 'missing-session', ptyId: 'pty-1' },
      { resolveTranscriptHost }
    )

    expect(resolveTranscriptHost).toHaveBeenCalledWith('pty-1')
  })

  it('fails closed when a supplied PTY identity is missing', async () => {
    const result = (await invokeReadSession(
      { agent: 'claude', sessionId: 'same-id', ptyId: 'missing-pty' },
      { resolveTranscriptHost: () => null }
    )) as { error?: string; notFound?: true }

    expect(result).toEqual({ error: 'Transcript unavailable' })
  })

  it('preserves notFound so a just-created session stays in retry/loading', async () => {
    const result = (await invokeReadSession({
      agent: 'claude',
      sessionId: 'missing-session',
      transcriptPath: join(tmpdir(), 'orca-native-chat-ipc-does-not-exist.jsonl')
    })) as { error?: string; notFound?: true }

    expect(result.error).toBeDefined()
    expect(result.notFound).toBe(true)
  })

  it('resolves a Claude transcript and returns the full conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-'))
    tempRoots.push(root)
    const projectsDir = join(root, '.claude', 'projects')
    const projectDir = join(projectsDir, '-repo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-ipc.jsonl')
    await writeFile(
      filePath,
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

    const result = (await invokeReadSession({
      agent: 'claude',
      sessionId: 'sess-ipc',
      transcriptPath: filePath
    })) as {
      messages?: unknown[]
      error?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.messages).toHaveLength(2)
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
    const filePath = join(projectDir, 'sess-limit.jsonl')
    await writeFile(filePath, jsonLines(records))

    const windowed = (await invokeReadSession({
      agent: 'claude',
      sessionId: 'sess-limit',
      transcriptPath: filePath,
      limit: 2
    })) as { messages: { id: string }[] }
    expect(windowed.messages.map((m) => m.id)).toEqual(['u-4', 'u-5'])

    const wider = (await invokeReadSession({
      agent: 'claude',
      sessionId: 'sess-limit',
      transcriptPath: filePath,
      limit: 4
    })) as { messages: { id: string }[] }
    expect(wider.messages.map((m) => m.id)).toEqual(['u-2', 'u-3', 'u-4', 'u-5'])
  })

  it('emits snapshot and appended frames and tears down on destroy', async () => {
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

    subscribe!(
      { sender },
      {
        subscriptionId: 'sub-1',
        agent: 'claude',
        sessionId: 'sess-sub',
        transcriptPath: filePath
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

    // The first frame is a bounded snapshot and later frames are appends.
    // Collect ids across both and assert the new turn shows up.
    const appendedIds = (): string[] =>
      sent
        .filter((s) => s.channel === 'nativeChat:appended')
        .flatMap((s) =>
          (s.payload as { frame: { messages: { id: string }[] } }).frame.messages.map((m) => m.id)
        )
    await waitFor(() => appendedIds().includes('a-1'))
    const appendedEvent = sent.find((s) => s.channel === 'nativeChat:appended')!
    const payload = appendedEvent.payload as { subscriptionId: string }
    expect(payload.subscriptionId).toBe('sub-1')
    expect(appendedIds()).toContain('a-1')

    // Destroyed window tears down the watcher without error.
    expect(destroyedCb).toBeDefined()
    destroyedCb!()
  })

  it('drops cleanup registration when sender is destroyed before subscribe completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-destroy-race-'))
    tempRoots.push(root)
    const projectDir = join(root, '.claude', 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-race.jsonl')
    await writeFile(
      filePath,
      `${jsonLines([
        {
          type: 'user',
          uuid: 'u-race',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'Race' }
        }
      ])}\n`
    )

    registerNativeChatHandlers()
    const subscribe = listeners.get('nativeChat:subscribe')
    expect(subscribe).toBeDefined()

    let destroyed = false
    let destroyedCb: (() => void) | undefined
    const sender = {
      id: 41,
      isDestroyed: () => destroyed,
      once: (event: string, cb: () => void) => {
        if (event === 'destroyed') {
          destroyedCb = cb
        }
      },
      send: vi.fn()
    }

    subscribe!(
      { sender },
      {
        subscriptionId: 'sub-race',
        agent: 'claude',
        sessionId: 'sess-race',
        transcriptPath: filePath
      }
    )

    expect(destroyedCb).toBeDefined()
    destroyed = true
    destroyedCb!()

    await waitFor(() => _getNativeChatSenderCleanupCountForTest() === 0)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('returns an error for an unknown session without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-ipc-missing-'))
    tempRoots.push(root)
    const result = (await invokeReadSession({
      agent: 'claude',
      sessionId: 'nope',
      transcriptPath: join(root, 'missing.jsonl')
    })) as { error?: string }
    expect(result.error).toBeTruthy()
  })
})
