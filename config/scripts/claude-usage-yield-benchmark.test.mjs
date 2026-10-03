import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(new URL('./claude-usage-yield-benchmark.mjs', import.meta.url))
const tempDirs = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('claude-usage-yield-benchmark', () => {
  it('still finds the scanner yield sites it is checked against', () => {
    // Why a fake HOME with one transcript: with none the benchmark falls back to
    // 7.5k synthetic transcripts, which takes seconds per round.
    const home = mkdtempSync(join(tmpdir(), 'orca-yield-benchmark-'))
    tempDirs.push(home)
    mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
    writeFileSync(join(home, '.claude', 'projects', 'p', 'session.jsonl'), '')

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, ORCA_YIELD_BENCH_ROUNDS: '1' }
    })

    expect(result.stderr).not.toContain('this benchmark is stale')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/sites=[1-9]/)
  })
})
