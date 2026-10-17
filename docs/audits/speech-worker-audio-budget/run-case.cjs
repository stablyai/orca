const assert = require('node:assert/strict')

async function waitFor(check, label) {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

exports.runCase = async function runCase({ SttService, kind, phase, context, scratch }) {
  const fixed = phase === 'fixed'
  const gate = new SharedArrayBuffer(16)
  const counters = new Int32Array(gate)
  context.gate = gate
  context.failOnce = kind === 'decode-error'
  const events = []
  const service = new SttService({
    getModelState: async () => ({ status: 'ready' }),
    getModelDir: () => scratch
  })
  let stopPromise
  await service.startDictation('local', (event) => {
    events.push(event)
    if (event.type === 'error') {
      stopPromise = service.stopDictation()
    }
  })
  const worker = service.state.worker
  const attemptedFrames = kind === 'tiny' ? 2048 : kind === 'decode-error' ? 2 : 1024
  const expectedFrames = !fixed || kind === 'decode-error' ? attemptedFrames : attemptedFrames / 2
  const perFrame = kind === 'tiny' ? 1 : 4096
  const first = new Float32Array(perFrame).fill(0)
  service.feedAudio(first, 16000)
  assert.equal(first.byteLength, 0)
  await waitFor(() => Atomics.load(counters, 0) === 1, 'native port stalled')
  global.gc?.()
  const baseline = process.memoryUsage()
  let transferredFrames = 1
  for (let index = 1; index < attemptedFrames; index++) {
    const frame = new Float32Array(perFrame).fill(index % 10)
    service.feedAudio(frame, 16000)
    if (frame.byteLength === 0) {
      transferredFrames += 1
    } else {
      assert.equal(frame.byteLength, perFrame * 4)
    }
  }
  assert.equal(transferredFrames, expectedFrames)
  const held = {
    bytes: transferredFrames * perFrame * 4,
    frames: transferredFrames,
    decoded: Atomics.load(counters, 2)
  }
  assert.equal(held.decoded, 0)
  if (fixed) {
    assert.equal(service.state.audioPending.pendingBytes, held.bytes)
    assert.equal(service.state.audioPending.pendingFrames, held.frames)
  }
  if (kind !== 'decode-error') {
    assert.equal(service.state.stopping, fixed)
    assert.equal(events.filter((event) => event.type === 'error').length, fixed ? 1 : 0)
  }
  global.gc?.()
  const atLimit = process.memoryUsage()
  if (!fixed && kind !== 'decode-error') {
    stopPromise = service.stopDictation()
  }
  Atomics.store(counters, 1, 1)
  Atomics.notify(counters, 1)
  await waitFor(
    () => events.some((event) => event.type === 'stopped'),
    'admitted audio drained and stop completed'
  )
  if (stopPromise) {
    await stopPromise
  }
  assert.equal(Atomics.load(counters, 2), transferredFrames)
  assert.equal(Atomics.load(counters, 3), transferredFrames * perFrame)
  if (fixed) {
    assert.equal(service.state.audioPending.pendingBytes, 0)
    assert.equal(service.state.audioPending.pendingFrames, 0)
  }
  assert.equal(events.filter((event) => event.type === 'stopped').length, 1)
  assert.equal(
    events.some((event) => event.type === 'audio-consumed'),
    false
  )
  const reportedError = events.find((event) => event.type === 'error')?.error ?? null
  if (kind === 'decode-error') {
    assert.match(reportedError, /Controlled recognizer failure/)
  } else if (fixed) {
    assert.match(reportedError, /cannot keep up/)
  } else {
    assert.equal(reportedError, null)
  }
  await service.startDictation('local', (event) => events.push(event))
  assert.equal(service.state.worker, worker)
  service.feedAudio(new Float32Array(perFrame).fill(transferredFrames % 10), 16000)
  await waitFor(
    () => Atomics.load(counters, 2) === transferredFrames + 1,
    'warm worker consumed next frame'
  )
  await service.stopDictation()
  await service.prepareModelForDeletion('local')
  if (fixed) {
    assert.equal(service.state.audioPending.owners.size, 0)
  }
  return {
    phase,
    kind,
    attemptedFrames,
    held,
    receivedFrames: transferredFrames,
    reportedError,
    finalPendingBytes: fixed ? service.state.audioPending.pendingBytes : null,
    warmReuse: true,
    rssDelta: atLimit.rss - baseline.rss,
    mainHeapDelta: atLimit.heapUsed - baseline.heapUsed
  }
}
