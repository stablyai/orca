#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../..', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'orca-hermes-correlation-'))
const baselineDirectory = process.argv[2]
const key = (seconds) =>
  new Date(Date.UTC(2026, 0, 1) + seconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .slice(0, 15)
try {
  for (const host of ['native', 'relay']) {
    const entry =
      host === 'native'
        ? 'src/main/automations/hermes-cron-run-content.ts'
        : 'src/relay/hermes-run-correlation.ts'
    const readers = []
    for (const mode of baselineDirectory ? ['baseline', 'current'] : ['current']) {
      const bundle = join(fixture, `${host}-${mode}.cjs`)
      await build({
        entryPoints: [join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        plugins:
          mode === 'baseline'
            ? [
                {
                  name: 'baseline-correlation',
                  setup(builder) {
                    builder.onLoad(
                      { filter: /hermes-(cron-run-content|run-correlation)\.ts$/ },
                      async (args) => ({
                        contents: await readFile(
                          join(baselineDirectory, basename(args.path)),
                          'utf8'
                        ),
                        loader: 'ts'
                      })
                    )
                  }
                }
              ]
            : []
      })
      readers.push({ mode, ...createRequire(import.meta.url)(bundle) })
    }
    if (readers.length === 2) {
      let seed = 92817
      const random = (max) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed % max
      }
      const pool = [
        null,
        '',
        'invalid',
        '20260101_000000',
        '20260101_000200',
        '20260102_000000',
        '20260103_000000',
        '20260101_240000'
      ]
      for (let trial = 0; trial < 200; trial++) {
        const sessions = Array.from({ length: random(70) }, (_, i) => ({
          kind: 'session',
          id: `session-${i}`,
          job_id: 'job',
          run_at: null,
          run_key: pool[random(pool.length)],
          output_content: `session ${i}`
        }))
        const outputs = Array.from({ length: random(70) }, (_, i) => ({
          kind: 'output',
          id: `output-${i}`,
          job_id: 'job',
          run_at: null,
          run_key: pool[random(pool.length)],
          output_path: 'unused',
          output_content: `output ${i}`
        }))
        for (const method of [
          'mergeHermesOutputAndSessionRunRefs',
          'mergeHermesOutputAndSessionRuns'
        ]) {
          assert.deepEqual(
            readers[1][method](outputs, sessions),
            readers[0][method](outputs, sessions)
          )
        }
      }
      console.log(JSON.stringify({ host, randomizedParityCases: 400 }))
    }
    for (const runs of [100, 1000, 5000]) {
      const sessions = Array.from({ length: runs }, (_, i) => ({
        kind: 'session',
        id: `session-${i}`,
        job_id: 'job',
        run_at: null,
        run_key: key(i * 3600)
      })).toReversed()
      const outputs = Array.from({ length: runs }, (_, i) => ({
        kind: 'output',
        id: `output-${i}`,
        job_id: 'job',
        run_at: null,
        run_key: key(i * 3600 + 120),
        output_path: 'unused'
      }))
      let expected
      for (const reader of [...readers, ...readers.toReversed()]) {
        const start = performance.now()
        const result = reader.mergeHermesOutputAndSessionRunRefs(outputs, sessions)
        const durationMs = performance.now() - start
        assert.equal(result.length, runs)
        result.forEach((row, i) => assert.equal(row.session.id, `session-${i}`))
        if (expected) {
          assert.deepEqual(result, expected)
        }
        expected = result
        console.log(JSON.stringify({ host, mode: reader.mode, runs, durationMs }))
      }
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true })
}
