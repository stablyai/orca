import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  finishModuleCache,
  moduleCacheIdentity,
  prepareModuleCache
} from './ci-unit-module-cache.mjs'

const temporary = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function options() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unit-cache-identity-'))
  temporary.push(directory)
  return {
    root: directory,
    cacheRoot: directory,
    policyHash: 'a'.repeat(64),
    installedLockHash: 'b'.repeat(64),
    versions: { node: '24.21.0', bun: '1.4.3', vitest: '5.0.3' },
    shard: { index: 1, count: 5 },
    platform: 'linux',
    arch: 'arm64',
    nodeEnv: 'test',
    namespace: ''
  }
}

describe('persistent unit module cache boundary', () => {
  it('separates hosts, runtimes, config, lockfiles, roots, shards and experiments', () => {
    const original = options()
    const identity = moduleCacheIdentity(original)
    const anotherRoot = options().root
    for (const update of [
      { root: anotherRoot },
      { policyHash: 'c'.repeat(64) },
      { installedLockHash: 'd'.repeat(64) },
      { platform: 'win32' },
      { arch: 'x64' },
      { nodeEnv: 'production' },
      { namespace: 'comparison' },
      { shard: { index: 2, count: 5 } },
      { shard: { index: 1, count: 10 } },
      { versions: { ...original.versions, node: '26.6.0' } },
      { versions: { ...original.versions, bun: '1.4.4' } },
      { versions: { ...original.versions, vitest: '5.0.4' } }
    ]) {
      const next = moduleCacheIdentity({ ...original, ...update })
      expect(next.key).not.toBe(identity.key)
      expect(next.path).toBe(identity.path)
    }
    expect(moduleCacheIdentity(original)).toEqual(identity)
  })

  it.each([
    { cacheRoot: '' },
    { policyHash: '' },
    { installedLockHash: '' },
    { versions: { node: '24', bun: '1.4.3', vitest: '5.0.3' } },
    { shard: { index: 0, count: 5 } },
    { shard: { index: 6, count: 5 } }
  ])('refuses an incomplete identity %j', (update) => {
    expect(() => moduleCacheIdentity({ ...options(), ...update })).toThrow('incomplete')
  })

  it.each([false, true])(
    'starts cold and discards unusable restored bytes (hit %s)',
    async (hit) => {
      const identity = moduleCacheIdentity(options())
      mkdirSync(identity.path)
      writeFileSync(join(identity.path, 'untrusted'), 'throw Error("must not execute")')
      const prepared = await prepareModuleCache(identity, { restoreHit: hit })
      expect(prepared.available).toBe(false)
      expect(prepared.validationMs).toBeGreaterThanOrEqual(0)
      expect(() => readFileSync(join(identity.path, 'untrusted'))).toThrow()
    }
  )
  it('restores a matching cache produced from an earlier source', async () => {
    const identity = moduleCacheIdentity(options())
    mkdirSync(identity.path)
    writeFileSync(
      join(identity.path, '_metadata.json'),
      JSON.stringify({ lockfileHash: identity.installedLockHash.slice(0, 8) })
    )
    const metadata = [
      { id: '1', url: '2', file: '1', imports: '3', mappings: false },
      join(identity.root, 'source.ts'),
      '/source.ts',
      { urls: '4', ids: '5' },
      [],
      {}
    ]
    writeFileSync(
      join(identity.path, 'a'.repeat(40)),
      `export const value = 1\n//# vitestCache=${Buffer.from(JSON.stringify(metadata)).toString('base64')}`
    )
    const produced = await finishModuleCache(identity, { sourceSha: 'a'.repeat(40) })
    expect(produced.entries).toBe(2)
    const prepared = await prepareModuleCache(
      { ...identity, sourceSha: 'b'.repeat(40) },
      { restoreHit: true }
    )
    expect(prepared).toMatchObject({
      available: true,
      entries: produced.entries,
      bytes: produced.bytes,
      producerSourceSha: 'a'.repeat(40)
    })
  })
})

it('restores the newest same-policy producer and saves only cold main or seeded producers', () => {
  const workflow = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))
  const steps = workflow.jobs.test.steps
  const dependencies = steps.findIndex(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  const identity = steps.findIndex((step) => step.id === 'module-cache')
  const restore = steps.findIndex((step) => step.id === 'module-cache-restore')
  const prepare = steps.findIndex((step) => step.run?.endsWith('ci-unit-module-cache.mjs prepare'))
  const tests = steps.findIndex((step) => step.name === 'Test shard')
  const seal = steps.find((step) => step.id === 'module-cache-seal')
  const save = steps.find((step) => step.uses === 'actions/cache/save@v5')
  expect(identity).toBeGreaterThan(dependencies)
  expect(restore).toBeGreaterThan(identity)
  expect(prepare).toBeGreaterThan(restore)
  expect(tests).toBeGreaterThan(prepare)
  expect(steps[restore].uses).toBe('actions/cache/restore@v5')
  expect(steps[restore].with['restore-keys']).toBe('${{ steps.module-cache.outputs.key }}-')
  expect(steps[restore]['continue-on-error']).toBe(true)
  const guard = seal.if.replaceAll(
    'steps.module-cache.outputs.key',
    'steps["module-cache"].outputs.key'
  )
  const producer = {
    event: 'schedule',
    ref: 'refs/heads/main',
    success: true,
    key: 'scoped',
    mode: 'cold',
    seed: false
  }
  for (const [name, update, expected] of [
    ['successful main producer', {}, true],
    ['PR', { event: 'pull_request', ref: 'refs/pull/1/merge' }, false],
    ['warm main consumer', { mode: 'warm' }, false],
    [
      'successful manually seeded branch',
      { event: 'workflow_dispatch', ref: 'refs/heads/experiment', seed: true },
      true
    ],
    ['missing identity', { key: '' }, false],
    ['ordinary branch push', { event: 'push', ref: 'refs/heads/experiment' }, false],
    ['unseeded manual branch', { event: 'workflow_dispatch', ref: 'refs/heads/experiment' }, false],
    [
      'seed does not admit a nonmanual event',
      { event: 'push', ref: 'refs/heads/experiment', seed: true },
      false
    ],
    ['failed main producer', { event: 'push', ref: 'refs/heads/main', success: false }, false]
  ]) {
    const control = { ...producer, ...update }
    const admitted = runInNewContext(guard, {
      github: { event_name: control.event, ref: control.ref },
      steps: {
        'module-cache': { outputs: { key: control.key } }
      },
      inputs: { module_cache: control.mode, module_cache_seed: control.seed },
      success: () => control.success
    })
    expect(admitted, name).toBe(expected)
  }
  expect(save.if).toBe("steps.module-cache-seal.outputs.ready == 'true'")
  expect(save.with.key.startsWith(steps[restore].with['restore-keys'])).toBe(true)
  expect(workflow.on.workflow_call.inputs.module_cache.default).toBe('off')
  expect(workflow.on.workflow_call.inputs.run_relay_integration.default).toBe(true)
})

it('retains four workers on ARM and the four-core x64 unit runners', () => {
  const workflow = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))
  const step = workflow.jobs.test.steps.find((step) => step.name === 'Test shard')
  const expression = [...step.run.matchAll(/\$\{\{(.+?)\}\}/g)].find((match) =>
    match[1].includes('--maxWorkers')
  )[1]
  for (const [arch, runner] of [
    ['ARM64', 'ubuntu-24.04-arm'],
    ['ARM64', 'blacksmith-4vcpu-ubuntu-2404-arm'],
    ['X64', 'blacksmith-4vcpu-ubuntu-2404'],
    ['X64', 'ubuntu-24.04']
  ]) {
    expect(runInNewContext(expression, { runner: { arch }, inputs: { runner } })).toBe(
      '--maxWorkers=4'
    )
  }
  expect(
    runInNewContext(expression, {
      runner: { arch: 'X64' },
      inputs: { runner: 'blacksmith-8vcpu-ubuntu-2404' }
    })
  ).toBe('--maxWorkers=8')
  expect(
    runInNewContext(expression, { runner: { arch: 'X64' }, inputs: { runner: 'ubuntu-latest' } })
  ).toBe('')
})

it('runs baseline, producer and warm controls serially with matching runtimes and shards', () => {
  const workflow = parse(readFileSync('.github/workflows/unit-module-cache-benchmark.yml', 'utf8'))
  const { baseline, producer, warm } = workflow.jobs
  expect(producer.needs).toBe('baseline')
  expect(warm.needs).toBe('producer')
  for (const job of [baseline, producer, warm]) {
    expect(job.uses).toBe('./.github/workflows/unit-tests.yml')
    expect(job.with.node_versions).toBe('["24.22.1"]')
    expect(job.with.runner).toBe('ubuntu-24.04-arm')
    expect(JSON.parse(job.with.shards)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ index: index + 1, count: 5 }))
    )
    expect(job.with.phase_diagnostics).toBe(true)
  }
  expect(producer.with.module_cache).toBe('cold')
  expect(producer.with.module_cache_seed).toBe(true)
  expect(warm.with.module_cache).toBe('warm')
  expect(warm.with.module_cache_namespace).toBe(producer.with.module_cache_namespace)
})
