import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runProcess } from '../../src/shared/child-process/run-process'
import { hashFile, report, runMsysCase } from './windows-msys-marker-investigation'

const caseMode = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length)
const variant = process.env.ORCA_INVESTIGATION_VARIANT ?? 'unknown'

async function collectSamples(): Promise<void> {
  assert.equal(process.platform, 'win32', 'Real Windows ConPTY is required')
  const resultDirectory = process.env.ORCA_INVESTIGATION_RESULTS
  assert.ok(resultDirectory, 'ORCA_INVESTIGATION_RESULTS is required')
  mkdirSync(resultDirectory, { recursive: true })
  const stress = join(__dirname, 'windows-pty-table-stress.cjs')
  const samples = [
    { id: 'table-1', args: [stress], timeoutMs: 90_000 },
    { id: 'original-1', args: [__filename, '--case=original'], timeoutMs: 30_000 },
    { id: 'control-1', args: [__filename, '--case=control'], timeoutMs: 30_000 },
    { id: 'ready-1', args: [__filename, '--case=ready'], timeoutMs: 30_000 },
    { id: 'table-2', args: [stress], timeoutMs: 90_000 },
    { id: 'original-2', args: [__filename, '--case=original'], timeoutMs: 30_000 },
    { id: 'ready-2', args: [__filename, '--case=ready'], timeoutMs: 30_000 },
    { id: 'control-2', args: [__filename, '--case=control'], timeoutMs: 30_000 }
  ]
  const results = []
  for (const sample of samples) {
    const sampleStarted = performance.now()
    appendFileSync(
      join(resultDirectory, 'schedule.jsonl'),
      `${JSON.stringify({ phase: 'start', variant, ...sample })}\n`
    )
    report('sample-start', sample)
    let result
    let spawnError: string | undefined
    try {
      result = await runProcess({
        program: process.execPath,
        args: sample.args,
        cwd: process.cwd(),
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_INVESTIGATION_SAMPLE: sample.id,
          ORCA_PTY_TABLE_STRESS_ROUNDS: '16'
        },
        timeoutMs: sample.timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024
      })
    } catch (error) {
      spawnError = error instanceof Error ? error.stack : String(error)
      result = {
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: spawnError ?? 'spawn failed',
        outputTruncated: false
      }
    }
    writeFileSync(join(resultDirectory, `${sample.id}.stdout.jsonl`), result.stdout)
    writeFileSync(join(resultDirectory, `${sample.id}.stderr.log`), result.stderr)
    const completed = result.stdout.includes(
      sample.id.startsWith('table') ? '"phase":"complete"' : '"phase":"passed"'
    )
    const outcome = {
      id: sample.id,
      variant,
      code: result.code,
      nativeStatusHex: result.code === null ? null : `0x${(result.code >>> 0).toString(16)}`,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated ?? false,
      elapsedMs: Math.round(performance.now() - sampleStarted),
      completed,
      spawnError,
      passed: result.code === 0 && !result.timedOut && !result.outputTruncated && completed
    }
    results.push(outcome)
    writeFileSync(
      join(resultDirectory, 'results.json'),
      `${JSON.stringify({ variant, stressSha256: hashFile(stress), results }, null, 2)}\n`
    )
    appendFileSync(
      join(resultDirectory, 'schedule.jsonl'),
      `${JSON.stringify({ phase: 'finish', ...outcome })}\n`
    )
    report('sample-finish', outcome)
  }
  assert.ok(
    results.every((result) => result.passed),
    'One or more scheduled samples failed; retain every outcome'
  )
}

void (caseMode ? runMsysCase(caseMode) : collectSamples()).catch((error) => {
  report('fatal', { message: error instanceof Error ? error.stack : String(error) })
  process.exitCode = 1
})
