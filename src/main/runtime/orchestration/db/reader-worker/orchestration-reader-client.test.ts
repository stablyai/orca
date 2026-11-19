import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { OrchestrationReaderClient } from './orchestration-reader-client'

// A reader stuck behind a contended database for a second before it answers.
const STALLED_READER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (request) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  parentPort.postMessage({ id: request.id, ok: true, value: { candidates: [], federated: [], asked: request.args.sessionIds.length } });
});
`

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const undo of cleanup.splice(0)) {
    undo()
  }
})

function fileDb(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orchestration-reader-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  cleanup.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return db
}

describe('orchestration reads', () => {
  it('fail a read the database never answers, rather than wait on this thread', async () => {
    const client = new OrchestrationReaderClient(
      () => new Worker(STALLED_READER, { eval: true }),
      100
    )
    cleanup.push(() => client.dispose())

    await expect(
      client.read(fileDb(), 'connectorWorkerCandidates', { sessionIds: ['chat'], now: 0 })
    ).rejects.toThrow(/timed out/)
  })
})
