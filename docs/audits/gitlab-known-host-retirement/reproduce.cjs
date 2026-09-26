const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { sourcePath, baseline, fixed, sourceHashes, hash } = require('./sources.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const symbol = Symbol.for('orca-known-host-comparison')
const context = { generation: 1, calls: 0, runner: null }
globalThis[symbol] = context
const resultFor = (host) => ({ stdout: `Logged in to ${host} as user`, stderr: '' })

async function load(phase) {
  const source = phase === 'baseline' ? baseline : fixed
  const built = await esbuild.build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'actual-cache-with-fixture-ports',
        setup(build) {
          build.onLoad({ filter: /gitlab-known-host-probe\.ts$/ }, () => ({
            contents: source,
            loader: 'ts'
          }))
          build.onResolve({ filter: /\/(runner|ssh-git-dispatch)$/ }, (args) => ({
            path: path.basename(args.path),
            namespace: 'ports'
          }))
          build.onLoad({ filter: /.*/, namespace: 'ports' }, (args) => ({
            loader: 'js',
            contents: `const context=globalThis[Symbol.for('orca-known-host-comparison')];${
              args.path === 'runner'
                ? `exports.glabExecFileAsync=(...args)=>{context.calls++;return context.runner(...args)};`
                : `exports.getSshGitProviderGeneration=()=>context.generation;`
            }`
          }))
        }
      }
    ]
  })
  const loaded = new Module(sourcePath, module)
  loaded.filename = sourcePath
  loaded.paths = module.paths
  loaded._compile(built.outputFiles[0].text, sourcePath)
  return loaded.exports
}

async function collect() {
  for (let index = 0; index < 6; index++) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
  await new Promise((resolve) => setImmediate(resolve))
}
async function rememberResult(api) {
  const hosts = await api.getGlabKnownHosts('same-connection')
  assert.deepEqual(hosts, ['gitlab.com', `host${context.generation}.test`])
  return new WeakRef(hosts)
}
async function retention(api) {
  api._resetKnownHostsCache()
  context.calls = 0
  context.runner = async () => resultFor(`host${context.generation}.test`)
  const refs = []
  for (let generation = 1; generation <= 128; generation++) {
    context.generation = generation
    refs.push(await rememberResult(api))
  }
  await collect()
  const retained = refs.filter((ref) => ref.deref() !== undefined).length
  await rememberResult(api)
  assert.equal(context.calls, 128)
  api._resetKnownHostsCache()
  await collect()
  const afterReset = refs.filter((ref) => ref.deref() !== undefined).length
  assert.equal(afterReset, 0)
  return { retained, afterReset }
}
async function afterReset(api) {
  api._resetKnownHostsCache()
  context.calls = 0
  const pending = Promise.withResolvers()
  context.runner = () => pending.promise
  const old = api.getGlabKnownHosts()
  api._resetKnownHostsCache()
  context.runner = async () => resultFor('fresh-after-reset.test')
  pending.resolve(resultFor('old-before-reset.test'))
  assert.deepEqual(await old, ['gitlab.com', 'old-before-reset.test'])
  return { hosts: await api.getGlabKnownHosts(), calls: context.calls }
}
async function weakResult(promise) {
  return new WeakRef(await promise)
}
async function lateGeneration(api) {
  api._resetKnownHostsCache()
  context.generation = 1
  const pending = Promise.withResolvers()
  context.runner = () => pending.promise
  let old = api.getGlabKnownHosts('same-connection')
  context.generation = 2
  context.runner = async () => resultFor('replacement-generation.test')
  assert.deepEqual(await api.getGlabKnownHosts('same-connection'), [
    'gitlab.com',
    'replacement-generation.test'
  ])
  pending.resolve(resultFor('retired-generation.test'))
  const oldResult = await weakResult(old)
  old = null
  await collect()
  const retained = oldResult.deref() !== undefined
  assert.deepEqual(await api.getGlabKnownHosts('same-connection'), [
    'gitlab.com',
    'replacement-generation.test'
  ])
  return { oldResultRetained: retained, replacementHostsPreserved: true }
}
async function rememberGeneration(api) {
  api._resetKnownHostsCache()
  context.runner = () => {
    throw new Error('remembered hosts must not probe')
  }
  const refs = []
  for (let generation = 1; generation <= 16; generation++) {
    context.generation = generation
    api.rememberGlabKnownHost(`host${generation}.test`, 'same-connection')
    refs.push(await rememberResult(api))
  }
  await collect()
  return refs.filter((ref) => ref.deref() !== undefined).length
}
async function abandonedProbe(api) {
  api._resetKnownHostsCache()
  const originalNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const pending = Promise.withResolvers()
    context.runner = () => pending.promise
    const old = api.getGlabKnownHosts()
    now += 60_001
    context.runner = async () => resultFor('replacement.test')
    assert.deepEqual(await api.getGlabKnownHosts(), ['gitlab.com', 'replacement.test'])
    pending.resolve(resultFor('abandoned.test'))
    await old
    return await api.getGlabKnownHosts()
  } finally {
    Date.now = originalNow
  }
}
async function rememberWhilePending(api, fail) {
  api._resetKnownHostsCache()
  const pending = Promise.withResolvers()
  context.runner = () => pending.promise
  const old = api.getGlabKnownHosts()
  api.rememberGlabKnownHosts(['Remembered.TEST', ' remembered.test '])
  if (fail) {
    pending.reject(new Error('controlled auth failure'))
  } else {
    pending.resolve(resultFor('gitlab.com'))
  }
  assert.deepEqual(await old, ['gitlab.com', 'remembered.test'])
  assert.deepEqual(await api.getGlabKnownHosts(), ['gitlab.com', 'remembered.test'])
}
async function scopeIsolation(api) {
  api._resetKnownHostsCache()
  const contexts = [
    [undefined, {}],
    [undefined, { wslDistro: 'Ubuntu' }],
    [undefined, { wslDistro: 'Debian' }],
    ['connection-a', {}],
    ['connection-b', {}]
  ]
  for (let index = 0; index < contexts.length; index++) {
    context.runner = async () => resultFor(`scope${index}.test`)
    assert.deepEqual(await api.getGlabKnownHosts(...contexts[index]), [
      'gitlab.com',
      `scope${index}.test`
    ])
  }
  context.runner = () => {
    throw new Error('cached contexts must not probe')
  }
  for (let index = 0; index < contexts.length; index++) {
    assert.deepEqual(await api.getGlabKnownHosts(...contexts[index]), [
      'gitlab.com',
      `scope${index}.test`
    ])
  }
}
async function main() {
  const proofHashes = Object.fromEntries(
    ['reproduce.cjs', 'sources.cjs', 'fix.patch', 'original-source-hashes.json'].map((file) => [
      file,
      hash(fs.readFileSync(path.join(__dirname, file)))
    ])
  )
  const report = { sourceHashes, proofHashes, runtime: process.versions, phases: {} }
  for (const phase of ['baseline', 'fixed']) {
    const api = await load(phase)
    const retained = await retention(api)
    const rememberedGenerationsRetained = await rememberGeneration(api)
    const oldGeneration = await lateGeneration(api)
    const reset = await afterReset(api)
    const abandoned = await abandonedProbe(api)
    await rememberWhilePending(api, false)
    await rememberWhilePending(api, true)
    await scopeIsolation(api)
    assert.equal(retained.retained, phase === 'baseline' ? 128 : 1)
    assert.equal(rememberedGenerationsRetained, phase === 'baseline' ? 16 : 1)
    assert.equal(oldGeneration.oldResultRetained, phase === 'baseline')
    assert.deepEqual(
      reset.hosts,
      phase === 'baseline'
        ? ['gitlab.com', 'old-before-reset.test']
        : ['gitlab.com', 'fresh-after-reset.test']
    )
    assert.deepEqual(
      abandoned,
      phase === 'baseline'
        ? ['gitlab.com', 'replacement.test', 'abandoned.test']
        : ['gitlab.com', 'replacement.test']
    )
    report.phases[phase] = {
      retained,
      rememberedGenerationsRetained,
      oldGeneration,
      reset,
      abandoned,
      rememberedSuccessAndFailure: 'passed',
      nativeWslConnectionIsolation: 'passed'
    }
    api._resetKnownHostsCache()
  }
  fs.writeFileSync(
    process.argv[2] || path.join(__dirname, 'results.json'),
    `${JSON.stringify(report, null, 2)}\n`
  )
  console.log(JSON.stringify(report.phases, null, 2))
}
main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    delete globalThis[symbol]
  })
setTimeout(() => {
  console.error('fixture deadline')
  process.exit(2)
}, 10000).unref()
