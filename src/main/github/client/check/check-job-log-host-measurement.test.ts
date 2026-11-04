import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareHostMeasurement, validateHostRecord } from './check-job-log-host-measurement.mjs'

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
})
