const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load, collect, sha, versions } = require('./queue-source.cjs')

const PAYLOAD_BYTES = 1024 * 1024
function liveCall(queue, method = 'git.status') {
  const hold = Promise.withResolvers()
  return {
    release: () => hold.resolve(),
    settled: queue.enqueue('fixture', method, () => hold.promise)
  }
}
function payloadCall(queue, method, hold, signal, throwSynchronously = false) {
  const payload = new Uint8Array(PAYLOAD_BYTES)
  payload[0] = 19
  const ref = new WeakRef(payload)
  const settled = queue.enqueue(
    'fixture',
    method,
    () => {
      if (throwSynchronously) {
        throw new Error(`fixture failure ${payload[0]}`)
      }
      return hold.then(() => payload[0])
    },
    payload.byteLength,
    signal
  )
  return { ref, settled }
}
function liveCount(refs) {
  return refs.filter((ref) => ref.deref() !== undefined).length
}

async function checkActiveAndCancelled(Queue, candidate, lane) {
  const queue = new Queue(1, 1)
  const method = lane === 'foreground' ? 'terminal.send' : 'git.status'
  const hold = Promise.withResolvers()
  const active = payloadCall(queue, method, hold.promise)
  const controller = new AbortController()
  const queued = payloadCall(queue, method, Promise.resolve(), controller.signal)
  const rejected = assert.rejects(queued.settled, { name: 'AbortError' })
  await collect()
  assert.equal(liveCount([active.ref, queued.ref]), 2)
  assert.equal(queue.retainedCallBytes, 2 * PAYLOAD_BYTES)
  controller.abort()
  await rejected
  await collect()
  assert.equal(liveCount([active.ref]), 1)
  assert.equal(liveCount([queued.ref]), 0)
  assert.equal(queue.retainedCallBytes, PAYLOAD_BYTES)
  assert.equal(queue.queuedCallCount, 0)
  hold.resolve()
  assert.equal(await active.settled, 19)
  await collect()
  assert.equal(liveCount([active.ref, queued.ref]), 0)
  assert.equal(queue.retainedCallBytes, 0)
  assert.equal(queue.queues.size, 0)
  return {
    candidate,
    case: 'active-and-cancelled',
    lane,
    activeRetainedUntilSettlement: true,
    cancelledReleasedBeforeActiveFinishes: true
  }
}

async function checkFailure(Queue, candidate, lane) {
  const queue = new Queue(3, 2)
  const hold = liveCall(queue, 'terminal.send')
  const method = lane === 'foreground' ? 'terminal.send' : 'git.status'
  let failed = payloadCall(queue, method, Promise.resolve(), undefined, true)
  const ref = failed.ref
  await assert.rejects(failed.settled, { message: 'fixture failure 19' })
  failed = null
  await collect()
  const retained = liveCount([ref])
  assert.equal(retained, candidate ? 0 : 1)
  assert.equal(queue.retainedCallBytes, 0)
  hold.release()
  await hold.settled
  await collect()
  assert.equal(liveCount([ref]), 0)
  assert.equal(queue.queues.size, 0)
  return {
    candidate,
    case: 'synchronous-failure',
    lane,
    retainedWhileOtherCallActive: retained,
    retainedAfterIdle: 0
  }
}

async function checkCrossLaneTraffic(Queue, candidate) {
  const queue = new Queue(3, 2)
  let current = liveCall(queue)
  const refs = []
  for (let index = 0; index < 8; index++) {
    const item = payloadCall(queue, 'terminal.send', Promise.resolve())
    refs.push(item.ref)
    assert.equal(await item.settled, 19)
  }
  for (let index = 0; index < 70; index++) {
    const next = liveCall(queue)
    current.release()
    await current.settled
    current = next
  }
  await collect()
  const retained = liveCount(refs)
  assert.equal(retained, candidate ? 0 : 8)
  assert.equal(queue.retainedCallBytes, 0)
  assert.equal(queue.queues.get('fixture').active, 1)
  assert.equal(queue.queues.get('fixture').foregroundHead, 8)
  assert.equal(queue.queues.get('fixture').backgroundHead, 5)
  current.release()
  await current.settled
  await collect()
  assert.equal(liveCount(refs), 0)
  assert.equal(queue.queues.size, 0)
  return {
    candidate,
    case: 'rolling-background-traffic',
    completedForegroundPayloads: 8,
    completedBackgroundCalls: 70,
    foregroundPayloadsStillRetained: retained,
    retainedAfterIdle: 0,
    everyBackgroundCallCompletes: true
  }
}

async function checkOrderAndCompaction(Queue, candidate) {
  const queue = new Queue(1, 1)
  const blocker = liveCall(queue, 'terminal.send')
  const started = []
  const pending = []
  const controllers = []
  for (const lane of ['background', 'foreground']) {
    for (let index = 0; index < 70; index++) {
      const id = `${lane}:${index}`
      const controller = new AbortController()
      const promise = queue.enqueue(
        'fixture',
        lane === 'background' ? 'git.status' : 'terminal.send',
        async () => {
          started.push(id)
          return id
        },
        0,
        controller.signal
      )
      pending.push(
        promise.then(
          (value) => ({ value }),
          (error) => ({ error: error.name })
        )
      )
      controllers.push({ id, controller })
    }
  }
  const cancelled = new Set([
    'foreground:0',
    'foreground:35',
    'foreground:69',
    'background:0',
    'background:35',
    'background:69'
  ])
  for (const { id, controller } of controllers) {
    if (cancelled.has(id)) {
      controller.abort()
    }
  }
  assert.equal(queue.queuedCallCount, 134)
  blocker.release()
  await blocker.settled
  const results = await Promise.all(pending)
  const expected = ['foreground', 'background']
    .flatMap((lane) => Array.from({ length: 70 }, (_, index) => `${lane}:${index}`))
    .filter((id) => !cancelled.has(id))
  assert.deepEqual(started, expected)
  assert.equal(results.filter((result) => result.error === 'AbortError').length, 6)
  assert.equal(results.filter((result) => result.value !== undefined).length, 134)
  await collect()
  assert.equal(queue.queuedCallCount, 0)
  assert.equal(queue.queues.size, 0)
  return {
    candidate,
    case: 'ordering-compaction-and-cancellation',
    completed: 134,
    cancelled: 6,
    foregroundBeforeBackground: true,
    fifoWithinEachLane: true,
    finalQueueCount: 0
  }
}

async function main() {
  const reports = []
  for (const candidate of [false, true]) {
    const Queue = load(candidate)
    for (const lane of ['foreground', 'background']) {
      reports.push(await checkActiveAndCancelled(Queue, candidate, lane))
      reports.push(await checkFailure(Queue, candidate, lane))
    }
    reports.push(await checkCrossLaneTraffic(Queue, candidate))
    reports.push(await checkOrderAndCompaction(Queue, candidate))
  }
  const report = {
    node: process.version,
    electron: process.versions.electron ?? null,
    versions,
    proofSha256: sha(fs.readFileSync(__filename)),
    reports
  }
  const resultName = process.versions.electron
    ? 'electron-extended-results.json'
    : 'extended-results.json'
  fs.writeFileSync(path.join(__dirname, resultName), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture timeout')
  process.exit(2)
}, 10000).unref()
