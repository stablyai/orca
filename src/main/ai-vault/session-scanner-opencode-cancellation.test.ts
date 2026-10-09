import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as workerSpawn from './session-scanner-opencode-sqlite-worker-spawn'
import type { SessionFileDiscovery } from './session-scanner-types'
import type { TranscriptReadOutcome } from './session-transcript-consumers'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'

const readers = vi.hoisted(() => ({
  parse: vi.fn<typeof workerSpawn.parseOpenCodeSqliteSessionViaWorker>(),
  capture: vi.fn<typeof workerSpawn.captureOpenCodeSqliteSessionViaWorker>(),
  discover: vi.fn<() => Promise<SessionFileDiscovery[]>>()
}))
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', () => ({
  parseOpenCodeSqliteSessionViaWorker: readers.parse,
  parseOpenCode2SqliteSessionViaWorker: readers.parse,
  captureOpenCodeSqliteSessionViaWorker: readers.capture,
  captureOpenCode2SqliteSessionViaWorker: readers.capture
}))
vi.mock('./session-scanner-source-discovery', () => ({
  discoverAiVaultSessionSources: readers.discover
}))
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests
} from './session-transcript-consumers'
import { runOpenCodeSqliteScanRequest } from './session-scanner-opencode-sqlite-scan-scope'

const file = {
  path: '/fixture/opencode.db#session',
  mtimeMs: 1,
  modifiedAt: new Date(1).toISOString()
}
const messages = [
  { role: 'user' as const, text: 'First', timestamp: null },
  { role: 'assistant' as const, text: 'Second', timestamp: null }
]

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionParseCacheForTests()
})
afterEach(() => {
  vi.useRealTimers()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
})

function configure(agent: 'opencode' | 'opencode2') {
  readers.discover.mockResolvedValue([{ agent, rootDir: '/fixture', files: [file] }])
  const accumulator = createAccumulator({ agent, file, sessionId: 'session' })
  accumulator.title = 'SQLite session'
  const session = finalizeSession(accumulator, 'linux')
  if (!session) {
    throw new Error('Configured SQLite session was empty')
  }
  return session
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) {
    throw new Error('SQLite request did not receive the scan signal')
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe.each(['opencode', 'opencode2'] as const)('%s scan cancellation', (agent) => {
  it('reports a deadline while retaining completed sessions and other agents, then retries', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-scan-deadline-'))
    try {
      const session = configure(agent)
      const blocked = { ...file, path: '/fixture/opencode.db#blocked' }
      const claudePath = join(root, 'claude.jsonl')
      writeFileSync(
        claudePath,
        `${JSON.stringify({
          type: 'user',
          sessionId: 'retained-claude',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: root,
          message: { role: 'user', content: 'Retain this other-agent session' }
        })}\n`
      )
      readers.discover.mockResolvedValue([
        { agent, rootDir: '/fixture', files: [file, blocked] },
        { agent: 'claude', rootDir: root, files: [{ ...file, path: claudePath }] }
      ])
      readers.parse.mockImplementation(({ sessionId, signal }) =>
        sessionId === 'blocked'
          ? runOpenCodeSqliteScanRequest(signal, untilAborted)
          : Promise.resolve(session)
      )
      const pending = scanAiVaultSessions({ platform: 'linux' })
      await vi.waitFor(() => expect(readers.parse).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await pending
      expect(result.sessions.map((row) => row.sessionId)).toEqual(
        expect.arrayContaining(['session', 'retained-claude'])
      )
      expect(result.sessions).toHaveLength(2)
      expect(result.issues).toEqual([
        expect.objectContaining({
          agent,
          path: blocked.path,
          message: expect.stringContaining('45s work budget')
        })
      ])
      readers.parse.mockResolvedValue({ ...session, sessionId: 'blocked', filePath: blocked.path })
      const recovered = await scanAiVaultSessions({ platform: 'linux' })
      expect(recovered.sessions).toHaveLength(3)
      expect(
        readers.parse.mock.calls.filter(([args]) => args.sessionId === 'blocked')
      ).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks a deadline capture incomplete instead of caching a failed history', async () => {
    vi.useFakeTimers()
    const session = configure(agent)
    const outcomes: TranscriptReadOutcome[] = []
    registerTranscriptConsumer({
      beginRead: () => ({ message() {}, finish: (outcome) => outcomes.push(outcome) })
    })
    readers.capture.mockImplementationOnce(({ signal }) =>
      runOpenCodeSqliteScanRequest(signal, untilAborted)
    )
    const pending = scanAiVaultSessions({ platform: 'linux' })
    await vi.waitFor(() => expect(readers.capture).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(45_000)
    const result = await pending
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining('45s work budget') })
    ])
    expect(outcomes).toEqual([{ session: null, byteOffset: 0, incomplete: true }])
    readers.capture.mockResolvedValue({ session, messages })
    expect((await scanAiVaultSessions({ platform: 'linux' })).sessions).toHaveLength(1)
    expect(readers.capture).toHaveBeenCalledTimes(2)
    expect(outcomes.at(-1)?.incomplete).toBe(false)
  })

  it.each(['parse', 'capture'] as const)(
    'cancels an active %s and retries the uncached read',
    async (mode) => {
      const session = configure(agent)
      const outcomes: TranscriptReadOutcome[] = []
      if (mode === 'capture') {
        registerTranscriptConsumer({
          beginRead: () => ({ message() {}, finish: (outcome) => outcomes.push(outcome) })
        })
        readers.capture.mockImplementationOnce(({ signal }) => untilAborted(signal))
      } else {
        readers.parse.mockImplementationOnce(({ signal }) => untilAborted(signal))
      }
      const controller = new AbortController()
      const pending = scanAiVaultSessions({ platform: 'linux', signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(readers[mode]).toHaveBeenCalledOnce())
      controller.abort(new Error('Cancelled SQLite scan'))
      await rejected
      if (mode === 'capture') {
        expect(outcomes).toEqual([{ session: null, byteOffset: 0, incomplete: true }])
      }
      readers.parse.mockResolvedValue(session)
      readers.capture.mockResolvedValue({ session, messages })
      const retried = await scanAiVaultSessions({ platform: 'linux' })
      expect(readers[mode]).toHaveBeenCalledTimes(2)
      expect(retried.sessions).toHaveLength(1)
      if (mode === 'capture') {
        expect(outcomes.at(-1)?.incomplete).toBe(false)
      }
    }
  )

  it('marks a partially delivered capture incomplete and never caches it', async () => {
    const session = configure(agent)
    const controller = new AbortController()
    const outcomes: TranscriptReadOutcome[] = []
    const received: string[] = []
    registerTranscriptConsumer({
      beginRead: () => ({
        message(message) {
          received.push(message.text)
          controller.abort()
        },
        finish: (outcome) => outcomes.push(outcome)
      })
    })
    readers.capture.mockResolvedValue({ session, messages })
    await expect(
      scanAiVaultSessions({ platform: 'linux', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(received).toEqual(['First'])
    expect(outcomes).toEqual([{ session: null, byteOffset: 0, incomplete: true }])
    resetTranscriptConsumersForTests()
    readers.parse.mockResolvedValue(session)
    expect((await scanAiVaultSessions({ platform: 'linux' })).sessions).toHaveLength(1)
    expect(readers.parse).toHaveBeenCalledOnce()
  })
})
