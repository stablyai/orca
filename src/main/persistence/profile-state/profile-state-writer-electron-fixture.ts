import { app } from 'electron'
import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../../window/foreground-activation-policy'
import { openProfileStateDatabase } from './profile-state-database'
import { readProfileStateRevision } from './profile-state-revision'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

const root = process.argv[2]
const timeoutMs = Number(process.argv[3])
if (!root || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error('Expected an isolated fixture directory and a positive timeout')
}
app.setPath('userData', root)
app.disableHardwareAcceleration()
applyBackgroundActivationPolicy()

function waitForQueuedReply(counts: Int32Array, expected: number): void {
  const deadline = performance.now() + 10_000
  for (;;) {
    const observed = Atomics.load(counts, 0)
    if (observed >= expected) {
      return
    }
    const remaining = deadline - performance.now()
    assert.ok(remaining > 0, 'Worker did not queue its reply')
    Atomics.wait(counts, 0, observed, remaining)
  }
}

async function run(): Promise<void> {
  await app.whenReady()
  applyBackgroundActivationPolicy()
  const databasePath = join(root, 'profile.db')
  const profileId = 'electron-stall-test'
  openProfileStateDatabase(databasePath, profileId).db.close()
  const counters = new SharedArrayBuffer(8)
  const counts = new Int32Array(counters)
  const failures: string[] = []
  const initialization = { databasePath, profileId, revision: 0, counters }
  const client = new ProfileStateWriteWorkerClient(initialization, {
    workerPath: join(root, 'observed-worker.cjs'),
    timeoutMs,
    onFailure: (error) => failures.push(error.message)
  })
  const write = (marker: string) =>
    client.writeSerializedDomains([{ domain: 'ui', payload: JSON.stringify({ marker }) }])
  const revisions: number[] = []
  try {
    await client.ready
    assert.equal(await write('before'), 1)
    for (let cycle = 0; cycle < 4; cycle += 1) {
      let pending: Promise<number> | undefined
      await new Promise<void>((resolve, reject) => {
        // Dispatch from check so the overdue timer runs before the next poll.
        setImmediate(() => {
          try {
            const started = performance.now()
            pending = write(`stalled-${cycle}`)
            waitForQueuedReply(counts, cycle + 2)
            Atomics.wait(
              new Int32Array(new SharedArrayBuffer(4)),
              0,
              0,
              Math.max(0, timeoutMs + 100 - (performance.now() - started))
            )
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
      if (!pending) {
        throw new Error('Write was not dispatched')
      }
      revisions.push(await pending)
    }
    assert.equal(await write('after'), 6)
  } finally {
    await client.close()
  }
  const opened = openProfileStateDatabase(databasePath, profileId)
  const durableRevision = readProfileStateRevision(opened.db)
  opened.db.close()
  assert.deepEqual(revisions, [2, 3, 4, 5])
  assert.equal(durableRevision, 6)
  assert.equal(Atomics.load(counts, 1), 1)
  assert.deepEqual(failures, [])
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      timeoutMs,
      revisions,
      durableRevision,
      workerStarts: Atomics.load(counts, 1),
      failures
    })
  )
}

void run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
