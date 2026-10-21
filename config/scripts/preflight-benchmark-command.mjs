import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { runProcess } from '@orca/process-host'

export async function measurePreflightCommand({
  program,
  args,
  label,
  root,
  output,
  env,
  timeoutMs = 240_000
}) {
  const resourceFile = path.join(output, `${label}.resources.txt`)
  const start = performance.now()
  const result = await runProcess({
    program: process.platform === 'linux' ? '/usr/bin/time' : program,
    args: process.platform === 'linux' ? ['-v', '-o', resourceFile, program, ...args] : args,
    cwd: root,
    env: { ...env, LC_ALL: 'C' },
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024
  })
  if (result.outputTruncated) {
    throw new Error(`Benchmark output was truncated: ${label}`)
  }
  const resources = process.platform === 'linux' ? readFileSync(resourceFile, 'utf8') : ''
  const peakRssKiB =
    Number(resources.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1]) || null
  return { ...result, durationMs: performance.now() - start, peakRssKiB }
}
