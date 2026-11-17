import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ReaderSlot } from './journal-sql-reader-slot'
import { readJournalReaderRequests } from './journal-sql-reader-requests'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('names the read a reader is running before it replies, and the next one once it does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-reader-requests-'))
  roots.push(root)
  const workerPath = join(root, 'held-reader.cjs')
  // Holds every request; answers only the first, once a third arrives.
  await writeFile(
    workerPath,
    `const { parentPort } = require('node:worker_threads')
const held = []
parentPort.on('message', (request) => {
  held.push(request)
  if (held.length === 3) parentPort.postMessage({ type: 'import-state', id: held[0].id, state: null })
})
parentPort.postMessage({ type: 'ready' })`
  )
  const slot = new ReaderSlot(join(root, 'db'), join(root, 'db'), workerPath)
  try {
    const first = slot.request({ kind: 'import-state', sessionId: 'session' })
    const rest = [
      slot.request({ kind: 'database', operation: { kind: 'epoch', sessionId: 'other' } }),
      slot.request({ kind: 'database', operation: { kind: 'sessions', after: null } })
    ]
    rest.forEach((request) => request.catch(() => {}))
    expect(readJournalReaderRequests()).toMatchObject([
      { reader: 0, operation: 'import-state', chat: '3f3af1ec', queued: 2 }
    ])
    await first
    expect(readJournalReaderRequests()).toMatchObject([
      { reader: 0, operation: 'database:epoch', chat: 'd9298a10', queued: 1 }
    ])
  } finally {
    await slot.close()
  }
  expect(readJournalReaderRequests()).toEqual([])
})
