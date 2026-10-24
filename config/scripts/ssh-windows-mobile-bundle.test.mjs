import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'

const workflow = parse(readFileSync('.github/workflows/ssh-windows-hosts.yml', 'utf8'))
const producer = workflow.jobs.mobile_web_bundle
const consumer = workflow.jobs.hosts
const upload = producer.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))
const download = consumer.steps.find((step) => step.id === 'mobile-bundle')
const fallback = consumer.steps.find(
  (step) => step.uses === './.github/actions/build-mobile-web-bundle'
)
const verify = consumer.steps.find(
  (step) => step.name === 'Verify the mobile bundle before staging it'
)

it('binds the bundle to the same run and source across architectures and retry attempts', () => {
  expect(producer['runs-on']).toBe('blacksmith-4vcpu-ubuntu-2404')
  for (const job of [producer, consumer]) {
    expect(
      job.steps.find((step) => step.uses?.startsWith('actions/checkout')).with.ref
    ).toBeUndefined()
  }
  expect(download.with['run-id']).toBeUndefined()
  expect(download.with.repository).toBeUndefined()
  const name = compileAggregateExpression(upload.with.name, ['github'])
  const requested = compileAggregateExpression(download.with.name, ['github'])
  for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
    const first = { github: { sha, run_attempt: 1 } }
    const retry = { github: { sha, run_attempt: 2 } }
    expect(name(first).coerceString()).toBe(requested(retry).coerceString())
    expect(name(first).coerceString()).toContain(sha)
  }
  expect(upload.with.overwrite).toBe(true)
  expect(upload.with.path).toBe(download.with.path)
})

it.each(['success', 'failure', 'cancelled', 'skipped', ''])(
  'admits Windows hosts only after a successful producer: %s',
  (result) => {
    const eligible = compileAggregateExpression(consumer.if, ['github', 'needs'])
    const value = {
      github: { event_name: 'pull_request', event: { pull_request: { draft: false } } },
      needs: { mobile_web_bundle: { result } }
    }
    expect(consumer.needs).toBe('mobile_web_bundle')
    expect(eligible(value).coerceString()).toBe(String(result === 'success'))
    expect(eligible(value, true).coerceString()).toBe('false')
  }
)

it.each(['success', 'failure', 'skipped', ''])(
  'rebuilds locally only when the artifact is unavailable: %s',
  (outcome) => {
    const eligible = compileAggregateExpression(fallback.if, ['steps'])
    expect(eligible({ steps: { 'mobile-bundle': { outcome } } }).coerceString()).toBe(
      String(outcome !== 'success')
    )
    expect(download['continue-on-error']).toBe(true)
    expect(fallback['continue-on-error']).toBeUndefined()
    expect(verify['continue-on-error']).toBeUndefined()
    const template = consumer.steps.findIndex((step) =>
      step.run?.includes('build-orcad-template.mjs')
    )
    expect(consumer.steps.indexOf(download)).toBeLessThan(consumer.steps.indexOf(fallback))
    expect(consumer.steps.indexOf(fallback)).toBeLessThan(consumer.steps.indexOf(verify))
    expect(consumer.steps.indexOf(verify)).toBeLessThan(template)
  }
)

it.skipIf(process.platform === 'win32')(
  'executes the consumer verifier without mobile dependencies and rejects corrupt assets',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ssh-mobile-bundle-'))
    try {
      mkdirSync(join(directory, 'config', 'scripts'), { recursive: true })
      for (const file of [
        'config/dark-build-switches.cjs',
        'config/scripts/verify-packaged-mobile-web-bundle.cjs'
      ]) {
        copyFileSync(file, join(directory, file))
      }
      const bundleDir = join(directory, 'out', 'mobile-web')
      await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
      const execute = () =>
        runProcessSync({
          program: 'bash',
          args: ['-e', '-o', 'pipefail', '-c', verify.run],
          cwd: directory
        })
      expect(execute().code).toBe(0)
      writeFileSync(join(bundleDir, 'index.html'), 'corrupt')
      expect(execute().code).not.toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
