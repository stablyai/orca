const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const Module = require('node:module')
const { getEventListeners } = require('node:events')
const { build } = require('esbuild')
const { root, before, after, hashes } = require('./sources.cjs')()
const settlementOrder = require('./settlement-order.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const sourcePath = 'src/main/rate-limits/auth-filesystem-operation.ts'
const entry = resolve(root, sourcePath)
let candidate = false
let createAuthFilesystemOperation
const turn = () => new Promise((resolveTurn) => setImmediate(resolveTurn))
async function collect() {
  for (let index = 0; index < 5; index++) {
    await turn()
    global.gc()
  }
  await turn()
}
const count = (refs) => refs.reduce((total, ref) => total + Number(ref.deref() !== undefined), 0)
async function abandonedWait(operation, index, amplify) {
  const controller = new AbortController()
  const reason = new Error(`synthetic expired poll ${index}`)
  // Payload amplifies the retained rejection object; normal timeout errors are much smaller.
  if (amplify) {
    reason.auditPayload = new Uint8Array(64 * 1024)
    reason.auditPayload.fill(index & 255)
  }
  const references = {
    reason: new WeakRef(reason),
    controller: new WeakRef(controller),
    ...(amplify ? { payload: new WeakRef(reason.auditPayload) } : {})
  }
  const waiting = operation.wait(controller.signal)
  controller.abort(reason)
  await waiting.catch(() => {})
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  return references
}
function snapshot(refs) {
  return {
    reasons: count(refs.map((ref) => ref.reason)),
    controllers: count(refs.map((ref) => ref.controller)),
    payloads: count(refs.flatMap((ref) => (ref.payload ? [ref.payload] : [])))
  }
}
async function retention(amplify) {
  let settleRaw
  let rawCalls = 0
  let operation = createAuthFilesystemOperation('/synthetic-local-auth', () => {
    rawCalls++
    return new Promise((resolveRaw) => {
      settleRaw = resolveRaw
    })
  })
  await turn()
  assert.equal(rawCalls, 1)
  const refs = []
  for (let index = 0; index < 128; index++) {
    refs.push(await abandonedWait(operation, index, amplify))
  }
  await collect()
  const unresolved = { ...snapshot(refs), rawCalls }
  if (candidate) {
    assert.equal(unresolved.reasons, 1)
  }
  settleRaw('finished')
  await operation.result
  await collect()
  const settled = snapshot(refs)
  assert.equal(settled.reasons, 1)
  operation = null
  settleRaw = null
  await collect()
  const dropped = snapshot(refs)
  assert.deepEqual(dropped, { reasons: 0, controllers: 0, payloads: 0 })
  return { amplify, abortedWaits: refs.length, unresolved, settled, dropped }
}
async function controls() {
  let rawCalls = 0
  let finish
  const operation = createAuthFilesystemOperation('/synthetic-auth-controls', () => {
    rawCalls++
    return new Promise((resolveRaw) => {
      finish = resolveRaw
    })
  })
  const expired = new AbortController()
  const expiredReason = new Error('expired first poll')
  const abortedWait = operation.wait(expired.signal)
  await turn()
  expired.abort(expiredReason)
  await assert.rejects(abortedWait, (reason) => reason === expiredReason)
  const later = new AbortController()
  const lateWait = operation.wait(later.signal)
  finish('late raw result')
  assert.equal(await lateWait, 'late raw result')
  assert.equal(rawCalls, 1)
  assert.equal(await operation.wait(later.signal), 'late raw result')
  assert.equal(getEventListeners(expired.signal, 'abort').length, 0)
  assert.equal(getEventListeners(later.signal, 'abort').length, 0)
  let rejectedCalls = 0
  const rejectedReason = new Error('raw rejected')
  const rejected = createAuthFilesystemOperation('/synthetic-auth-rejected', async () => {
    rejectedCalls++
    throw rejectedReason
  })
  await assert.rejects(
    rejected.wait(new AbortController().signal),
    (reason) => reason === rejectedReason
  )
  let preAbortedCalls = 0
  const preAborted = createAuthFilesystemOperation('/synthetic-auth-pre-aborted', async () => {
    preAbortedCalls++
    return 'unexpected'
  })
  const priorAbort = new AbortController()
  priorAbort.abort(expiredReason)
  await assert.rejects(preAborted.wait(priorAbort.signal), (reason) => reason === expiredReason)
  await assert.rejects(preAborted.result, (reason) => reason === expiredReason)
  assert.equal(preAbortedCalls, 0)
  let finishReasons
  const reasonOperation = createAuthFilesystemOperation(
    '/synthetic-auth-reasons',
    () =>
      new Promise((resolveRaw) => {
        finishReasons = resolveRaw
      })
  )
  await turn()
  const reasons = [false, 0, 'string abort', { code: 'custom' }]
  for (const reason of reasons) {
    const controller = new AbortController()
    const pending = reasonOperation.wait(controller.signal)
    controller.abort(reason)
    await assert.rejects(pending, (observed) => observed === reason)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
  const activeController = new AbortController()
  const cancelledController = new AbortController()
  const active = reasonOperation.wait(activeController.signal)
  const cancelled = reasonOperation.wait(cancelledController.signal)
  cancelledController.abort(expiredReason)
  await assert.rejects(cancelled, (reason) => reason === expiredReason)
  finishReasons('active result')
  assert.equal(await active, 'active result')
  assert.equal(getEventListeners(activeController.signal, 'abort').length, 0)
  return {
    lateResultDelivered: true,
    settledResultDelivered: true,
    oneRawCall: rawCalls,
    rawRejectionPreserved: rejectedCalls === 1,
    preAbortedRawCalls: preAbortedCalls,
    allAbortListenersRemoved: true,
    arbitraryAbortReasonsPreserved: reasons.length,
    liveSiblingSurvivesAbort: true
  }
}
async function phase(sources, fixed) {
  candidate = fixed
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'hash-fenced-proof-source',
        setup(api) {
          api.onLoad(
            { filter: /(?:auth-filesystem-operation|promise-settlement-waiters)\.ts$/ },
            (args) =>
              sources.has(args.path)
                ? {
                    contents: sources.get(args.path),
                    loader: 'ts',
                    resolveDir: resolve(args.path, '..')
                  }
                : undefined
          )
        }
      }
    ]
  })
  const bundled = built.outputFiles[0].text
  const moduleOwner = new Module(entry, module)
  moduleOwner.filename = entry
  moduleOwner.paths = module.paths
  moduleOwner._compile(bundled, entry)
  createAuthFilesystemOperation = moduleOwner.exports.createAuthFilesystemOperation
  const importedHashes = Object.fromEntries(
    Object.keys(built.metafile.inputs)
      .filter((path) => !sources.has(resolve(root, path)))
      .map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex')
      ])
  )
  return {
    cases: [await retention(false), await retention(true)],
    controls: await controls(),
    settlementOrder: await settlementOrder(createAuthFilesystemOperation),
    importedHashes,
    bundleSha256: createHash('sha256').update(bundled).digest('hex')
  }
}
async function run() {
  const result = {
    sourceHashes: hashes,
    runtime: process.versions,
    scenario:
      '128 aborted waits on one already-started unresolved operation; amplified arm has 64 KiB synthetic payload per abort Error; real native filesystem stall not reproduced',
    before: await phase(before, false),
    after: await phase(after, true)
  }
  assert.deepEqual(result.after.settlementOrder, result.before.settlementOrder)
  const output = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(__dirname, `${process.versions.electron ? 'electron-' : 'node-'}results.json`)
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
}
const deadline = setTimeout(() => {
  console.error('Auth wait proof exceeded 15 seconds')
  process.exit(1)
}, 15_000)
run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(deadline))
