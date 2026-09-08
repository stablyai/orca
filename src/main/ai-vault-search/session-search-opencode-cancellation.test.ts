import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { OpenCodeSqliteParentMessage } from '../ai-vault/session-scanner-opencode-sqlite-worker-protocol'
import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import Database from '../sqlite/sync-database'
import { OpenCodeSqliteWorkerClient } from '../ai-vault/session-scanner-opencode-sqlite-worker-client'
import { OpenCodeWorkerSearchCapture } from '../ai-vault/session-search-opencode-worker-capture'
import {
  withSessionSearchIndexRequired,
  withStreamingSessionSearchCapture
} from '../ai-vault/session-search-capture'
import { parseOpenCodeSqliteSession } from '../ai-vault/session-scanner-opencode-sqlite'
import {
  applyOpenCodeSqliteSchema,
  insertOpenCodeMessage,
  insertOpenCodePart,
  insertOpenCodeSession
} from '../ai-vault/session-scanner-opencode-sqlite-fixtures'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import { SessionSearchService } from './session-search-service'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
const injected = vi.hoisted(() => ({
  client: null as OpenCodeSqliteWorkerClient | null,
  candidate: null as SessionFileCandidate | null
}))
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  parseOpenCodeSqliteSessionViaWorker: (args: Parameters<OpenCodeSqliteWorkerClient['parse']>[0]) =>
    injected.client!.parse(args)
}))
vi.mock('../ai-vault/session-scanner-source-discovery', () => ({
  discoverAiVaultSessionSources: async () => []
}))
vi.mock('../ai-vault/session-scanner-candidates', () => ({
  sessionCandidatesFromDiscoveries: async () => [injected.candidate]
}))
class LoopbackWorker extends EventEmitter {
  capture: OpenCodeWorkerSearchCapture | null = null
  ack: Extract<OpenCodeSqliteParentMessage, { kind: 'captureAck' }> | null = null
  batches = 0
  produced = 0
  terminated = false
  controller = new AbortController()
  finished: Promise<void> = Promise.resolve()
  unref() {}
  async terminate() {
    this.terminated = true
    // Model thread termination by unwinding the real SQLite producer at its suspended checkpoint.
    this.controller.abort()
    if (this.ack) {
      this.releaseAck()
    }
    await this.finished
    return 0
  }
  postMessage(request: OpenCodeSqliteParentMessage) {
    if (request.kind === 'captureAck') {
      this.ack = request
      return
    }
    if (request.kind !== 'parse') {
      throw new Error('Expected parse')
    }
    this.capture = new OpenCodeWorkerSearchCapture(request.id, (batch) => {
      this.batches++
      setImmediate(() => this.emit('message', structuredClone(batch)))
    })
    const capture = this.capture
    const source = {
      push: (message: Parameters<typeof capture.push>[0]) => {
        this.produced++
        capture.push(message)
      },
      checkpoint: () => capture.checkpoint()
    }
    this.finished = withSessionSearchIndexRequired(
      () => withStreamingSessionSearchCapture(source, () => parseOpenCodeSqliteSession(request)),
      this.controller.signal
    )
      .then(async (session) => {
        await capture.flush()
        this.emit('message', { id: request.id, kind: 'result', value: { session } })
      })
      .catch((error) => {
        if (!this.terminated) {
          this.emit('error', error)
        }
      })
  }
  releaseAck() {
    const ack = this.ack
    this.ack = null
    this.capture!.acknowledge(ack!.batch)
  }
}
it('pauses an OpenCode pass at the outstanding batch without draining or publishing the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-capture-cancel-'))
  const dbPath = join(root, 'opencode.db'),
    id = 'ses_cancelproof'
  const db = new Database(dbPath)
  applyOpenCodeSqliteSchema(db)
  const now = Date.now()
  insertOpenCodeSession(db, { id, timeCreated: now, timeUpdated: now })
  insertOpenCodeMessage(db, { id: 'm', sessionId: id, role: 'user', timeCreated: now })
  db.exec('BEGIN')
  for (let n = 0; n < 40; n++) {
    insertOpenCodePart(db, {
      id: `p${n}`,
      sessionId: id,
      messageId: 'm',
      timeCreated: now + n,
      text: 'x'.repeat(190000)
    })
  }
  db.exec('COMMIT')
  db.close()
  const worker = new LoopbackWorker()
  injected.client = new OpenCodeSqliteWorkerClient({
    workerFactory: () => worker as unknown as Worker
  })
  injected.candidate = {
    agent: 'opencode',
    codexHome: null,
    file: { path: `${dbPath}#${id}`, mtimeMs: now, modifiedAt: new Date(now).toISOString() }
  }
  resetSessionParseCacheForTests()
  const service = new SessionSearchService({
    databasePath: join(root, 'index.sqlite'),
    enabled: true,
    historyDays: null
  })
  const roots = isolatedScanRoots(root)
  try {
    const pass = service.ensureBackfill(roots)
    await vi.waitFor(() => expect(worker.ack).not.toBeNull())
    const atPause = worker.produced
    const pause = service.configure({ enabled: true, paused: true, historyDays: null }, roots)
    await pause
    await pass
    await worker.finished
    expect(atPause).toBe(2)
    expect(worker.produced).toBe(atPause)
    expect(worker.batches).toBe(1)
    expect(worker.terminated).toBe(true)
    expect(service.coverage().sessionsIndexed).toBe(0)
  } finally {
    await service.close()
    resetSessionParseCacheForTests()
    await rm(root, { recursive: true, force: true })
  }
})
