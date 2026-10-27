import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  hash,
  prepareHostMeasurement,
  validateHostRecord
} from './check-job-log-host-measurement.mjs'
import { workload } from '../../../../../config/scripts/check-job-log-performance-cases.mjs'

let context: Awaited<ReturnType<typeof prepareHostMeasurement>>
let copy: string
beforeAll(async () => {
  context = await prepareHostMeasurement()
  copy = await mkdtemp(path.join(tmpdir(), 'orca-host-measurement-identity-'))
  for (const name of Object.keys(context.identity.sourceHashes)) {
    const target = path.join(copy, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, await readFile(path.join(context.root, name)))
  }
})
afterAll(async () => {
  await context?.cleanup()
  if (copy) {
    await rm(copy, { recursive: true, force: true })
  }
})

describe('standalone host measurement identity', () => {
  it('hashes the actual source closure and all separately executed policy inputs', async () => {
    expect(context.identity.bundleSources).toContain('src/shared/github/repository-identity-key.ts')
    expect(context.identity.bundleSources).toContain('src/main/git/command-runner/abort-error.ts')
    expect(context.identity.executedSources).toEqual([
      'config/scripts/check-job-log-byte-cap-benchmark.mjs',
      'config/scripts/check-job-log-performance-cases.mjs',
      'src/main/github/client/check/check-job-log-cache-retention-child.mjs',
      'src/main/github/client/check/check-job-log-host-measurement.mjs'
    ])
    expect(Object.keys(context.identity.sourceHashes).sort()).toEqual(
      [...new Set([...context.identity.bundleSources, ...context.identity.executedSources])].sort()
    )
    for (const [name, digest] of Object.entries(context.identity.sourceHashes)) {
      expect(digest).toBe(hash(await readFile(path.join(context.root, name))))
    }
    expect(context.identity.tools.node.binaryHash).toMatch(/^[a-f0-9]{64}$/)
    expect(context.identity.tools.esbuild.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each([
    'src/main/github/client/check/check-job-log-host-measurement.mjs',
    'src/main/github/client/check/check-job-log-cache-retention-child.mjs',
    'config/scripts/check-job-log-performance-cases.mjs',
    'config/scripts/check-job-log-byte-cap-benchmark.mjs',
    'src/shared/github/repository-identity-key.ts',
    'src/main/git/command-runner/abort-error.ts'
  ])('rejects stale record identity after an owned-copy mutation of %s', async (name) => {
    const target = path.join(copy, name)
    const original = await readFile(target)
    await writeFile(target, Buffer.concat([original, Buffer.from('\n// identity mutation\n')]))
    try {
      const changed = await prepareHostMeasurement(copy)
      try {
        expect(changed.identity.sourceHashes[name]).not.toBe(context.identity.sourceHashes[name])
        expect(changed.identityHash).not.toBe(context.identityHash)
        expect(() => validateHostRecord(changed, { identityHash: context.identityHash })).toThrow(
          'Measurement identity mismatch'
        )
        expect(changed.identity.bundleHash).toBe(context.identity.bundleHash)
      } finally {
        await changed.cleanup()
      }
    } finally {
      await writeFile(target, original)
    }
  })

  it.each(['descriptor', 'byte-count', 'input-hash', 'node-selection'])(
    'checks %s against actual generated input outside timing',
    (field) => {
      const descriptor = { ...context.identity.cpuDescriptors[0], bytes: 4096 }
      const text = workload(descriptor).text
      const small = { ...context, identity: { ...context.identity, cpuDescriptors: [descriptor] } }
      const record = {
        identityHash: context.identityHash,
        runtime: { executableHash: hash(context.program), gc: true, background: true },
        cpu: [{ workload: descriptor, inputBytes: Buffer.byteLength(text), inputHash: hash(text) }]
      }
      expect(() => validateHostRecord(small, record)).not.toThrow()
      if (field === 'descriptor') {
        record.cpu[0].workload = { ...descriptor, family: 'changed' }
      }
      if (field === 'byte-count') {
        record.cpu[0].inputBytes += 1
      }
      if (field === 'input-hash') {
        record.cpu[0].inputHash = hash(`${text}changed`)
      }
      if (field === 'node-selection') {
        record.runtime.executableHash = hash('different Node')
      }
      expect(() => validateHostRecord(small, record)).toThrow()
    }
  )
})
