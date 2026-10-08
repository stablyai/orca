const assert = require('node:assert/strict')
const { Writable } = require('node:stream')
const pause = () => new Promise((resolve) => setImmediate(resolve))
async function collect() {
  for (let i = 0; i < 8; i++) {
    await pause()
    global.gc()
  }
  await pause()
}
async function scenario(api, fixed, release, laneName) {
  let drain,
    current,
    writes = 0,
    next = 0,
    accepted = 0
  const weak = [],
    callbacks = []
  const mux = new api.SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write(bytes, settle) {
      assert.equal(current, undefined)
      const msg = JSON.parse(bytes.subarray(13).toString())
      assert.equal(
        laneName === 'ordinary' ? Number.parseInt(msg.params.data, 10) : msg.params.seq,
        writes
      )
      weak.push(new WeakRef(bytes))
      callbacks.push(new WeakRef([...mux.writer.inFlight][0].onSettled))
      current = settle
      writes++
      return false
    },
    onDrain(fn) {
      drain = fn
      return () => {
        drain = undefined
      }
    },
    onData() {},
    onClose() {},
    pauseReads() {},
    resumeReads() {},
    close() {}
  })
  const enqueue = () => {
    const id = next++
    if (laneName === 'ordinary') {
      const promise = api.writeToSshPtyWithSettlement(
        mux,
        'synthetic-pty',
        `${id}:${'x'.repeat(256)}`
      )
      void promise.then((result) => {
        if (result.outcome === 'accepted') {
          accepted++
        }
      })
    } else {
      mux.notify('git.responseAck', { streamId: 1, seq: id })
    }
  }
  const settle = () => {
    assert.ok(current)
    const cb = current
    current = undefined
    cb({ ok: true })
    if (laneName === 'control') {
      accepted++
    }
  }
  enqueue()
  enqueue()
  enqueue()
  settle()
  for (let i = 0; i < 2048; i++) {
    drain()
    settle()
    enqueue()
  }
  await collect()
  const lane = mux.writer.scheduler[laneName]
  const completedAlive = weak.reduce((n, w) => n + (w.deref() !== undefined), 0)
  const during = {
    completedWrites: writes,
    accepted,
    completedBuffersAlive: completedAlive,
    completedCallbacksAlive: callbacks.reduce((n, w) => n + (w.deref() !== undefined), 0),
    logicalFrames: mux.writer[`${laneName}Frames`],
    logicalBytes: mux.writer[`${laneName}Bytes`],
    physicalSlots: lane.entries.length,
    head: lane.head,
    liveQueued: lane.entries.length - lane.head,
    disposed: mux.isDisposed()
  }
  assert.equal(during.liveQueued, 2)
  assert.equal(during.logicalFrames, 2)
  assert.equal(during.disposed, false)
  assert.equal(accepted, writes)
  assert.equal(completedAlive, fixed ? 0 : 2048)
  assert.equal(during.completedCallbacksAlive, fixed ? 0 : 2048)
  const sibling = laneName === 'ordinary' ? 'control' : 'ordinary'
  assert.equal(mux.writer.scheduler[sibling].entries.length, 0)
  assert.equal(mux.writer[`${sibling}Frames`], 0)
  if (release === 'drain') {
    drain()
    settle()
    drain()
    settle()
  } else {
    mux.dispose()
  }
  await collect()
  const after = {
    completedBuffersAlive: weak.reduce((n, w) => n + (w.deref() !== undefined), 0),
    physicalSlots: lane.entries.length,
    logicalFrames: mux.writer[`${laneName}Frames`],
    logicalBytes: mux.writer[`${laneName}Bytes`],
    disposed: mux.isDisposed()
  }
  assert.equal(after.completedBuffersAlive, 0)
  assert.equal(after.physicalSlots, 0)
  assert.equal(after.logicalFrames, 0)
  mux.dispose()
  return { fixed, release, laneName, during, after }
}

async function realWritableScenario(api, fixed) {
  let complete,
    writes = 0,
    accepted = 0
  const weak = []
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(bytes, encoding, callback) {
      assert.equal(complete, undefined)
      assert.equal(
        Number.parseInt(JSON.parse(bytes.subarray(13).toString()).params.data, 10),
        writes
      )
      weak.push(new WeakRef(bytes))
      writes++
      complete = callback
    }
  })
  const mux = new api.SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write: (bytes, onSettled) =>
      sink.write(bytes, (error) => onSettled(error ? { ok: false, error } : { ok: true })),
    onDrain: (fn) => {
      sink.on('drain', fn)
      return () => sink.off('drain', fn)
    },
    onData() {},
    onClose() {},
    close() {}
  })
  let next = 0
  const enqueue = () =>
    void api
      .writeToSshPtyWithSettlement(mux, 'synthetic-pty', `${next++}:${'x'.repeat(16 * 1024)}`)
      .then((result) => {
        if (result.outcome === 'accepted') {
          accepted++
        }
      })
  const completeWrite = async () => {
    assert.ok(complete)
    const cb = complete
    complete = undefined
    cb()
    await pause()
  }
  enqueue()
  enqueue()
  enqueue()
  for (let i = 0; i < 128; i++) {
    await completeWrite()
    enqueue()
  }
  await collect()
  const retained = weak.reduce((n, w) => n + (w.deref() !== undefined), 0)
  const result = {
    kind: 'real-node-writable',
    fixed,
    writes,
    accepted,
    logicalFrames: mux.writer.ordinaryFrames,
    logicalBytes: mux.writer.ordinaryBytes,
    physicalSlots: mux.writer.scheduler.ordinary.entries.length,
    retainedBuffers: retained
  }
  assert.equal(accepted, 128)
  assert.equal(writes, 129)
  assert.equal(result.logicalFrames, 3)
  assert.equal(retained, fixed ? 1 : 128)
  while (complete) {
    await completeWrite()
  }
  await collect()
  assert.equal(
    weak.reduce((n, w) => n + (w.deref() !== undefined), 0),
    0
  )
  assert.equal(mux.writer.scheduler.ordinary.entries.length, 0)
  assert.equal(mux.writer.ordinaryFrames, 0)
  mux.dispose()
  sink.destroy()
  return result
}
async function inFlightOwnership(api, fixed) {
  let current, drain
  const weak = []
  const mux = new api.SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write(bytes, fn) {
      weak.push(new WeakRef(bytes))
      current = fn
      return false
    },
    onDrain(fn) {
      drain = fn
      return () => {
        drain = undefined
      }
    },
    onData() {},
    onClose() {},
    close() {}
  })
  const pending = api.writeToSshPtyWithSettlement(mux, 'synthetic-pty', 'in-flight')
  const queued = api.writeToSshPtyWithSettlement(mux, 'synthetic-pty', 'queued')
  mux.dispose()
  const pendingResult = await pending,
    queuedResult = await queued
  assert.equal(pendingResult.outcome, 'unverifiable')
  assert.equal(queuedResult.outcome, 'refused')
  await collect()
  const retainedByNativeCallback = weak.reduce((n, w) => n + (w.deref() !== undefined), 0)
  assert.equal(retainedByNativeCallback, 1)
  assert.equal(drain, undefined)
  current({ ok: true })
  current({ ok: false, error: new Error('synthetic late duplicate') })
  current = undefined
  await collect()
  assert.equal(
    weak.reduce((n, w) => n + (w.deref() !== undefined), 0),
    0
  )
  return {
    kind: 'in-flight-callback-ownership',
    fixed,
    retainedByNativeCallback,
    afterNativeCallbackRelease: 0,
    pendingResult,
    queuedResult
  }
}

module.exports = { scenario, realWritableScenario, inFlightOwnership }
