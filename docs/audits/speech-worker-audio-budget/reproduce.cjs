const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const esbuild = require('esbuild')
const { root, sourceHashes, originalSourcePlugin } = require('./sources.cjs')
const { runCase } = require('./run-case.cjs')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-speech-budget-'))
const context = { gate: null, failOnce: false, workers: [] }
globalThis[Symbol.for('orca-speech-budget-proof')] = context
const budget = 8 * 1024 * 1024

async function buildPhase(phase) {
  const sourcePlugins = phase === 'baseline' ? [originalSourcePlugin()] : []
  const workerPath = path.join(scratch, `${phase}-worker.cjs`)
  const recognizer = path.join(__dirname, 'recognizer.cjs')
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/speech/stt-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
    plugins: sourcePlugins
  })
  const ports = {
    'stt-worker-paths': `exports.getSttWorkerPath=()=>${JSON.stringify(workerPath)};exports.getSherpaModulePath=()=>${JSON.stringify(recognizer)};`,
    'model-catalog':
      'exports.getCatalogModel=(id)=>({id,provider:"local",type:"transducer",streaming:true,sampleRate:16000,files:["tokens.txt","encoder.onnx","decoder.onnx","joiner.onnx"]});',
    'openai-api-key-store': 'exports.readOpenAiSpeechApiKey=()=>"";',
    'worker-constructor': `const {Worker}=require('node:worker_threads');const ctx=globalThis[Symbol.for('orca-speech-budget-proof')];exports.Worker=class extends Worker{constructor(file,options){super(file,{...options,workerData:{...options.workerData,gate:ctx.gate,failOnce:ctx.failOnce}});ctx.workers.push(this)}};`
  }
  const servicePath = path.join(scratch, `${phase}-service.cjs`)
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/speech/stt-service.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: servicePath,
    plugins: [
      ...sourcePlugins,
      {
        name: 'model-location-ports',
        setup(build) {
          build.onResolve(
            { filter: /\/(stt-worker-paths|model-catalog|openai-api-key-store)$/ },
            (args) => ({ path: path.basename(args.path), namespace: 'speech-proof-ports' })
          )
          build.onResolve({ filter: /^node:worker_threads$/ }, (args) =>
            args.namespace === 'speech-proof-ports'
              ? { path: args.path, external: true }
              : { path: 'worker-constructor', namespace: 'speech-proof-ports' }
          )
          build.onLoad({ filter: /.*/, namespace: 'speech-proof-ports' }, (args) => ({
            contents: ports[args.path],
            loader: 'js'
          }))
        }
      }
    ]
  })
  return { SttService: require(servicePath).SttService }
}

async function main() {
  const cases = []
  for (const phase of ['baseline', 'fixed']) {
    const { SttService } = await buildPhase(phase)
    for (const kind of ['bytes', 'tiny', 'decode-error']) {
      cases.push(await runCase({ SttService, kind, phase, context, scratch }))
    }
  }
  const proofSources = Object.fromEntries(
    [
      'sources.cjs',
      'run-case.cjs',
      'recognizer.cjs',
      'reproduce.cjs',
      'fix.patch',
      'original-source-hashes.json'
    ].map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, file)))
        .digest('hex')
    ])
  )
  const result = {
    runtime: process.versions,
    byteLimit: budget,
    frameLimit: 1024,
    sourceHashes,
    dependencyHashes: Object.fromEntries(
      [
        'src/main/speech/stt-audio-resample.ts',
        'src/main/speech/stt-offline-audio-chunker.ts',
        'src/main/speech/stt-worker-model-config.ts',
        'src/main/speech/stt-worker-stop.ts',
        'src/main/speech/stt-session-timeouts.ts',
        'src/main/speech/stt-audio-pending-budget.test.ts',
        'src/main/speech/stt-audio-pending-test-fixture.ts',
        'src/main/speech/stt-audio-test-worker.ts',
        'src/main/speech/stt-worker-audio-ack.test.ts'
      ].map((file) => [
        file,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, file)))
          .digest('hex')
      ])
    ),
    proofSources,
    cases
  }
  fs.writeFileSync(
    process.argv[2] || path.join(__dirname, 'results.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
  console.log(JSON.stringify(cases))
}
main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (context.gate) {
      const counters = new Int32Array(context.gate)
      Atomics.store(counters, 1, 1)
      Atomics.notify(counters, 1)
    }
    await Promise.all(context.workers.map((worker) => worker.terminate().catch(() => {})))
    for (const file of Object.keys(require.cache)) {
      if (file.startsWith(scratch + path.sep)) {
        delete require.cache[file]
      }
    }
    delete globalThis[Symbol.for('orca-speech-budget-proof')]
    fs.rmSync(scratch, { recursive: true, force: true })
  })
