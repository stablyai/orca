import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
})

function configure(agent: 'opencode' | 'opencode2') {
  readers.discover.mockResolvedValue([{ agent, rootDir: '/fixture', files: [file] }])
  const accumulator = createAccumulator({ agent, file, sessionId: 'session' })
  accumulator.title = 'SQLite session'
  return finalizeSession(accumulator, 'linux')
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
