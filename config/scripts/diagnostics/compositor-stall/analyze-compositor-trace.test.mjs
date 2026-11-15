import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it } from 'vitest'

let directory
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'compositor-analysis-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.each([
  {
    name: 'worker budget refusal while reading',
    trace: JSON.stringify({ traceEvents: [{ pid: 41, tid: 7, ph: 'X', name: 'x'.repeat(257) }] }),
    reason: 'parser-budget'
  },
  { name: 'truncated JSON at completion', trace: '{"traceEvents":[', reason: 'trace-invalid' },
  {
    name: 'invalid event while reading',
    trace: JSON.stringify({
      traceEvents: [{ pid: 41, tid: 7, ph: 'X', name: 'cc::Scheduler::FinishImplFrame', dur: -1 }]
    }),
    reason: 'trace-invalid'
  }
])('reports $name without transport ids or input contents', async ({ trace, reason }) => {
  const file = join(directory, 'input.json')
  await writeFile(file, trace)
  const result = await runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [fileURLToPath(new URL('./analyze-compositor-trace.mjs', import.meta.url)), file, '41'],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 15_000,
    terminationBarrier: true
  })
  expect(result.code, result.stderr).toBe(1)
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason })
})

it('waits for a successful worker result in a fresh Node process', async () => {
  const file = join(directory, 'input.json')
  await writeFile(file, '{"traceEvents":[]}')
  const result = await runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [fileURLToPath(new URL('./analyze-compositor-trace.mjs', import.meta.url)), file, '41'],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 15_000,
    terminationBarrier: true
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, observations: [{ pid: 41 }] })
})
