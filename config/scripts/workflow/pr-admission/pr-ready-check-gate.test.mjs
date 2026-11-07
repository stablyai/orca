import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  aggregateEnvironment,
  aggregateNeeds,
  aggregateRequiredJobs as requiredJobs,
  aggregateSelectors,
  aggregateShell as gate
} from './pr-aggregate-gate-context.mjs'

async function verifyCases(environments, script, env = {}) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const cases = environments.map((environment, index) => {
    const exports = Object.entries(environment)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join('\n')
    return `(\n${exports}\n${script}\n)\nprintf 'AGGREGATE_CASE_${index}=%s\\n' "$?"`
  })
  const directory = mkdtempSync(join(tmpdir(), 'orca-aggregate-cases-'))
  const file = join(directory, 'cases.sh')
  try {
    writeFileSync(file, cases.join('\n'))
    const result = await runProcess({
      program: 'bash',
      args: [file],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env },
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    return [...result.stdout.matchAll(/^AGGREGATE_CASE_\d+=(\d+)$/gm)].map((match) =>
      Number(match[1])
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const malformedSelectors = [
  '',
  'TRUE',
  'True',
  'FALSE',
  '0',
  '1',
  'null',
  'unknown',
  ' true',
  'true\n',
  undefined,
  null
]
const outcomes = ['success', 'skipped', 'failure', 'cancelled', '', 'unknown', undefined, null]

// The aggregate runs as Bash on Linux; Windows has no required Bash installation.
describe.skipIf(process.platform === 'win32')(
  'required PR checks through the real aggregate shell',
  () => {
    it('rejects missing, failed, cancelled or incorrectly skipped required results', async () => {
      const cases = []
      const expected = []
      for (const selected of ['true', 'false']) {
        for (const job of ['code_paths', ...requiredJobs]) {
          for (const result of outcomes) {
            const needs = aggregateNeeds(selected)
            needs[job].result = result
            cases.push(aggregateEnvironment(needs))
            const correct = job === 'code_paths' || selected === 'true' ? 'success' : 'skipped'
            expected.push(result === correct ? 0 : 1)
          }
          const missing = aggregateNeeds(selected)
          delete missing[job]
          cases.push(aggregateEnvironment(missing))
          expected.push(1)
        }
      }
      expect(await verifyCases(cases, gate.run)).toEqual(expected)
    })

    it('rejects every malformed or masked raw selector even when downstream jobs were skipped', async () => {
      const cases = []
      for (const job of aggregateSelectors) {
        for (const selected of malformedSelectors) {
          cases.push(aggregateEnvironment(aggregateNeeds('false', { [job]: selected })))
        }
        const missing = aggregateNeeds('false')
        delete missing.code_paths.outputs[job]
        cases.push(aggregateEnvironment(missing))
      }
      expect(await verifyCases(cases, gate.run)).toEqual(cases.map(() => 1))
    })
  }
)
