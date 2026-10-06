const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  loadExports,
  evaluatedSourceHashes,
  sourceMode,
  reportPrefix,
  sha
} = require('./spawn-source.cjs')
const { subprocess, collect } = require('./spawn-fixture.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const root = path.resolve(__dirname, '../../..')

function observeOptions(refs, host) {
  return {
    createOrAttach(options) {
      refs.options = new WeakRef(options)
      refs.env = new WeakRef(options.env)
      refs.history = new WeakRef(options.historySeedChunks)
      refs.signal = new WeakRef(options.cancelSignal)
      return host.createOrAttach(options)
    },
    detach: (...args) => host.detach(...args)
  }
}

function observePreparations(refs, preparations) {
  return {
    register(...args) {
      const preparation = preparations.register(...args)
      refs.preparation = new WeakRef(preparation)
      return preparation
    },
    prepareUnlessCanceled: (...args) => preparations.prepareUnlessCanceled(...args),
    finish: (...args) => preparations.finish(...args)
  }
}

async function create(admission, refs) {
  const request = {
    id: 'request',
    type: 'createOrAttach',
    payload: {
      sessionId: 'admission-review',
      cols: 80,
      rows: 24,
      env: { REVIEW: 'request-input' },
      historySeed: 'ADMISSION-HISTORY-SEED\r\n'
    }
  }
  refs.request = new WeakRef(request)
  refs.payload = new WeakRef(request.payload)
  const result = await admission.createOrAttach('client', request)
  assert.equal(result.isNew, true)
  assert.equal(result.historySeeded, true)
}

async function exercise(api) {
  const refs = {}
  const host = new api.TerminalHost({ spawnSubprocess: async () => subprocess() })
  const preparations = new api.DaemonPtySpawnPreparations(async () => {})
  const client = { authenticatedPairEstablished: true, streamSocket: {} }
  const attachments = []
  const admission = new api.DaemonTerminalAdmission({
    host: observeOptions(refs, host),
    preparations: observePreparations(refs, preparations),
    connections: new Map([['client', client]]),
    endpoint: { hasLostOwnership: () => false },
    attachments: {
      attach(...args) {
        attachments.push(args)
      },
      release() {},
      lastInputAt: () => undefined
    },
    historySeedTransfers: {
      take() {
        throw new Error('Inline history only')
      }
    },
    transientFactRelay: { isBackgrounded: () => false, onSessionData() {}, onSessionExit() {} },
    streamDataBatcher: {
      enqueue() {},
      enqueueControlEvent() {},
      flush() {},
      refreshSessionDroppability() {}
    },
    log: { log() {} },
    isAcceptingWork: () => true,
    requestEndpointRetirement() {
      throw new Error('Unexpected endpoint retirement')
    },
    reevaluateIdleShutdown() {}
  })
  const retained = () =>
    Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))
  try {
    await create(admission, refs)
    assert.equal(admission.inFlight, 0)
    assert.equal(preparations.pending.size, 0)
    await collect()
    const attached = retained()
    assert.equal(host.listSessions().length, 1)
    assert.match(host.getSnapshot('admission-review').snapshotAnsi, /ADMISSION-HISTORY-SEED/)
    assert.equal(attachments.length, 1)
    host.detach('admission-review', attachments[0][2])
    await collect()
    const detached = retained()
    assert.equal(host.listSessions().length, 1)
    await host.dispose()
    await collect()
    const disposed = retained()
    assert(Object.values(disposed).every((value) => !value))
    return { attached, detached, disposed, historyVisibleAfterCollection: true }
  } finally {
    await host.dispose()
  }
}

async function main() {
  const phases = {}
  for (const phase of ['baseline', 'fixed']) {
    const result = await exercise(await loadExports(phase === 'fixed'))
    for (const key of ['options', 'env', 'history']) {
      assert.equal(result.attached[key], phase === 'baseline')
      assert.equal(result.detached[key], phase === 'baseline')
    }
    for (const key of ['preparation', 'signal']) {
      assert.equal(result.attached[key], true)
      assert.equal(result.detached[key], phase === 'baseline')
    }
    for (const key of ['request', 'payload']) {
      assert.equal(result.attached[key], false)
      assert.equal(result.detached[key], false)
    }
    phases[phase] = result
  }
  const sourceHashes = { ...evaluatedSourceHashes }
  for (const file of [
    'src/main/daemon/daemon-terminal-admission.ts',
    'src/main/daemon/daemon-pty-spawn-preparations.ts'
  ]) {
    sourceHashes[file] = sha(fs.readFileSync(path.join(root, file)))
  }
  const report = {
    node: process.version,
    electron: process.versions.electron ?? null,
    v8: process.versions.v8,
    sourceMode,
    sourceHashes,
    phases
  }
  fs.writeFileSync(
    path.join(
      __dirname,
      `${reportPrefix}admission-${process.versions.electron ? 'electron' : 'node'}.json`
    ),
    `${JSON.stringify(report, null, 2)}\n`
  )
  console.log(JSON.stringify(phases, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture timeout')
  process.exit(2)
}, 15000).unref()
