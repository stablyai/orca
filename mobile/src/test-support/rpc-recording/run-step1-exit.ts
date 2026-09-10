import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProcessSpec, ProcessResult } from '../../../../src/shared/child-process/process-spec'
import { MUTATION_NAMES } from './operation-mutations'
import { readScenarios } from './scenario-input'

export type Step1ExitOptions = {
  scenarios: string
  goldens: string
  determinismRuns: number
  requireMutants: readonly string[]
}

export async function runStep1Exit(options: Step1ExitOptions): Promise<{
  ok: true
  stdout: string
  stderr: string
  scenarios: number
  mutants: readonly string[]
}> {
  if (!Number.isInteger(options.determinismRuns) || options.determinismRuns < 2) {
    throw new Error('Step 1 requires at least two determinism runs')
  }
  if (options.requireMutants.some((name) => !MUTATION_NAMES.includes(name as never))) {
    throw new Error('Unknown required mutant')
  }
  const input = readScenarios(resolve(options.scenarios))
  for (const id of ['b1', 'b2', 'b3']) {
    if (!input.scenarios.some((scenario) => scenario.id === id)) {
      throw new Error(`Missing required seed: ${id}`)
    }
  }
  const root = resolve(import.meta.dirname, '../../../..')
  const directory = resolve(options.goldens)
  const digest = () =>
    createHash('sha256')
      .update(
        readdirSync(directory)
          .sort()
          .map((file) => `${file}:${readFileSync(resolve(directory, file))}`)
          .join('\n')
      )
      .digest('hex')
  const before = digest()
  const require = createRequire(resolve(root, 'mobile/package.json'))
  const { runProcess } = (await import(
    pathToFileURL(resolve(root, 'src/shared/child-process/run-process.ts')).href
  )) as { runProcess: (spec: ProcessSpec) => Promise<ProcessResult> }
  const result = await runProcess({
    program: process.execPath,
    args: [
      resolve(require.resolve('vitest/package.json'), '../vitest.mjs'),
      'run',
      'src/test-support/rpc-recording/pilot-recordings.test.ts',
      'src/test-support/rpc-recording/family-recordings.test.ts'
    ],
    cwd: resolve(root, 'mobile'),
    timeoutMs: 120_000,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      RPC_FOUNDATION_MODE: 'candidate',
      RPC_FOUNDATION_RECORD: '0',
      RPC_FOUNDATION_SCENARIOS: resolve(options.scenarios),
      RPC_FOUNDATION_GOLDENS: directory,
      RPC_FOUNDATION_DETERMINISM_RUNS: String(options.determinismRuns)
    }
  })
  if (digest() !== before) {
    throw new Error('Candidate execution changed goldens')
  }
  if (result.code !== 0) {
    throw new Error(`Step 1 failed (${result.code}):\n${result.stdout}\n${result.stderr}`)
  }
  return {
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    scenarios: input.scenarios.length,
    mutants: options.requireMutants
  }
}
