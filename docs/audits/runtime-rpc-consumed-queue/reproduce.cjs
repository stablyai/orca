const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load, collect, sha, versions } = require('./queue-source.cjs')
async function postInput(queue, method, index) {
  const data = new Uint8Array(1024 * 1024)
  data[0] = index
  const ref = new WeakRef(data)
  await queue.enqueue('fixture', method, async () => data[0], data.byteLength)
  return ref
}
async function postResult(queue, method, index) {
  let ref
  await queue.enqueue('fixture', method, async () => {
    const data = new Uint8Array(1024 * 1024)
    data[0] = index
    ref = new WeakRef(data)
    return { data }
  })
  assert(ref)
  return ref
}
async function lifetime(Queue, candidate, kind, lane, completed, releaseByIdle = false) {
  const queue = new Queue(3, 2)
  const hold = Promise.withResolvers()
  const stuck = queue.enqueue('fixture', 'fixture.hold', () => hold.promise)
  const method = lane === 'background' ? 'git.status' : 'fixture.echo'
  const refs = []
  const before = process.memoryUsage()
  for (let i = 0; i < completed; i++) {
    refs.push(await (kind === 'input' ? postInput : postResult)(queue, method, i))
  }
  await collect()
  const retainedBeforeCompaction = refs.filter((ref) => ref.deref()).length
  const { historyLength, head } = (() => {
    const state = queue.queues.get('fixture')
    assert(state)
    return { historyLength: state[lane].length, head: state[`${lane}Head`] }
  })()
  assert.equal(queue.retainedCallBytes, 0)
  assert.equal(queue.queuedCallCount, 0)
  if (candidate || kind === 'input') {
    assert.equal(retainedBeforeCompaction, candidate ? 0 : completed)
  }
  const afterCompleted = process.memoryUsage()
  if (releaseByIdle) {
    hold.resolve(0)
    await stuck
  }
  const completionsUntilCompaction = releaseByIdle ? 0 : 33 - head
  for (let i = 0; i < completionsUntilCompaction; i++) {
    await queue.enqueue('fixture', method, async () => 0)
  }
  await collect()
  const retainedAfterCompaction = refs.filter((ref) => ref.deref()).length
  assert.equal(retainedAfterCompaction, 0)
  hold.resolve(0)
  await stuck
  await collect()
  assert.equal(queue.queues.size, 0)
  return {
    candidate,
    kind,
    lane,
    completed,
    releaseByIdle,
    historyLength,
    head,
    retainedBeforeCompaction,
    retainedAfterCompaction,
    activeCreditBytesAfterCompleted: 0,
    finalQueues: queue.queues.size,
    memoryDelta: {
      external: afterCompleted.external - before.external,
      heapUsed: afterCompleted.heapUsed - before.heapUsed
    }
  }
}
async function main() {
  const reports = []
  for (const candidate of [false, true]) {
    const Queue = load(candidate)
    for (const [kind, lane, completed, releaseByIdle] of [
      ['input', 'foreground', 8, false],
      ['input', 'background', 8, false],
      ['input', 'foreground', 8, true],
      ['result', 'foreground', 8, false]
    ]) {
      reports.push(await lifetime(Queue, candidate, kind, lane, completed, releaseByIdle))
      console.log(JSON.stringify(reports.at(-1)))
    }
  }
  const resultName = process.versions.electron ? 'electron-results.json' : 'results.json'
  fs.writeFileSync(
    path.join(__dirname, resultName),
    `${JSON.stringify({ node: process.version, electron: process.versions.electron ?? null, versions, proofSha256: sha(fs.readFileSync(__filename)), reports }, null, 2)}\n`
  )
}
module.exports = { load, collect, sha }
if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  setTimeout(() => {
    console.error('fixture timeout')
    process.exit(2)
  }, 10000).unref()
}
