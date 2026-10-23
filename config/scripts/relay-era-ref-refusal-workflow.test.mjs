// Desktop builds no longer compile the Windows relay addon, so every workflow that packages an
// arbitrary ref must refuse one that still ships the relay rather than ship it without the addon.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'

const STEP = 'Refuse a ref that still ships the SSH relay'
const directory = mkdtempSync(join(tmpdir(), 'relay-era-ref-refusal-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function steps(workflow, job) {
  return parse(readFileSync(`.github/workflows/${workflow}`, 'utf8')).jobs[job].steps
}

async function runAt(run, relayEra) {
  const checkout = mkdtempSync(join(directory, 'ref-'))
  mkdirSync(join(checkout, 'config'))
  if (relayEra) {
    writeFileSync(join(checkout, 'config', 'tsconfig.relay.json'), '{}')
  }
  writeFileSync(join(checkout, 'step.sh'), run)
  return runProcess({ program: 'bash', args: ['step.sh'], cwd: checkout })
}

const refusalTargets = [
  // The refusal must precede everything that tags, signs or publishes.
  [
    'adhoc-mac-build.yml',
    'orcad-template-support',
    'Detect whether the ref ships the orcad template'
  ],
  ['release-cut.yml', 'cut', 'Resolve ref SHA'],
  // Dispatchable on its own with any tag, so release-cut's refusal does not cover it.
  ['release-mac-build.yml', 'build-mac', 'Build app'],
  ['dev-channel-win-build.yml', 'build-win', 'Build app']
].map(([workflow, job, laterStep]) => {
  const jobSteps = steps(workflow, job)
  const index = jobSteps.findIndex((step) => step.name === STEP)
  return { workflow, laterStep, jobSteps, index }
})

describe.each(refusalTargets)(
  '$workflow refuses a relay-era ref',
  ({ jobSteps, index, laterStep }) => {
    it('checks the ref before it builds or tags anything', () => {
      expect(index).toBeGreaterThan(0)
      expect(jobSteps[index - 1].uses).toMatch(/^actions\/checkout@/)
      const sparse = jobSteps[index - 1].with['sparse-checkout']
      expect(sparse?.split('\n').includes('/config/tsconfig.relay.json') ?? true).toBe(true)
      expect(index).toBeLessThan(jobSteps.findIndex((step) => step.name === laterStep))
    })
  }
)

it('fails only when the checkout still has the relay for each distinct refusal command', async () => {
  const commands = new Set(refusalTargets.map(({ jobSteps, index }) => jobSteps[index].run))
  for (const run of commands) {
    expect((await runAt(run, true)).code).toBe(1)
    expect((await runAt(run, false)).code).toBe(0)
  }
})
