const assert = require('node:assert/strict')

function subprocess() {
  let dataListener
  let exitListener
  return {
    pid: 424242,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    signal() {},
    kill() {
      exitListener?.(0)
    },
    forceKill() {
      exitListener?.(137)
    },
    terminateOwnedTree: () => 'unavailable',
    onData(listener) {
      dataListener = listener
    },
    onExit(listener) {
      exitListener = listener
    },
    dispose() {
      dataListener = undefined
      exitListener = undefined
    },
    emitData(data) {
      dataListener?.(data)
    },
    emitExit(code) {
      exitListener?.(code)
    }
  }
}

// These callbacks must not share a lexical context with the request's signal.
const streamClient = { onData() {}, onExit() {} }
function startWithInputs(host, sessionId) {
  const controller = new AbortController()
  const env = { RETENTION_FIXTURE: 'x'.repeat(1024) }
  const historySeedChunks = ['retention-seed\r\n']
  const options = {
    sessionId,
    cols: 80,
    rows: 24,
    env,
    historySeedChunks,
    streamClient,
    cancelSignal: controller.signal,
    isCanceled: () => controller.signal.aborted
  }
  return {
    refs: {
      options: new WeakRef(options),
      env: new WeakRef(env),
      history: new WeakRef(historySeedChunks),
      signal: new WeakRef(controller.signal)
    },
    creation: host.createOrAttach(options)
  }
}

function counts(refs) {
  return Object.fromEntries(
    ['options', 'env', 'history', 'signal'].map((key) => [
      key,
      refs.filter((ref) => ref[key].deref() !== undefined).length
    ])
  )
}
const expected = (count) => ({ options: count, env: count, history: count, signal: count })
async function collect() {
  assert.equal(typeof global.gc, 'function')
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
}
module.exports = { subprocess, streamClient, startWithInputs, counts, expected, collect }
