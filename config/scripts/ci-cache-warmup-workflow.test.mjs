import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { NODE_SERVER_RUNNERS } from './node-server-qualification.mjs'

const readWorkflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
const workflow = readWorkflow('ci-cache-warmup')
const steps = workflow.jobs.warm.steps

it('warms the same Linux Node runtime the PR shards restore', () => {
  const arm = workflow.jobs['warm-linux-arm']
  const install = arm.steps.find(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  const primer = readWorkflow('pr').jobs.static_analysis
  expect(arm['runs-on']).toBe(primer['runs-on'])
  expect(arm.steps.at(-1).run).toBe('node config/scripts/ensure-native-runtime.mjs --check-only')
  expect(install.with).toMatchObject(primer.steps.find((step) => step.uses === install.uses).with)
})

it('populates shared Electron archives on both Linux architectures without changing the Node ABI', () => {
  for (const name of ['warm', 'warm-linux-arm']) {
    const steps = workflow.jobs[name].steps
    const install = steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    expect(install.with['native-runtime']).toBe('node')
    expect(install.with['cache-electron-package']).toBe('true')
    const populate = steps.find((step) => step.name === 'Populate shared Electron archive')
    expect(populate.run).toBe('node config/scripts/install-electron-package-binary.mjs')
    expect(steps.indexOf(populate)).toBeGreaterThan(steps.indexOf(install))
  }
})

it('publishes incremental state under a key and prefix that new PRs restore', () => {
  const cache = steps.find((step) => step.id === 'typecheck-cache')
  const prCache = readWorkflow('pr').jobs.typecheck.steps.find((step) => step.name === cache.name)
  expect(cache.with.path).toBe(prCache.with.path)
  expect(cache.with['restore-keys']).toBe(prCache.with['restore-keys'])
  expect(cache.with.key).toBe(
    prCache.with.key.replace('github.event.pull_request.base.sha', 'github.sha')
  )
  const check = steps.find((step) => step.run === 'pnpm run typecheck')
  expect(check.if).toBe("steps.typecheck-cache.outputs.cache-hit != 'true'")
  expect(steps.indexOf(check)).toBeGreaterThan(steps.indexOf(cache))
})

it('bounds warming to the required platforms and validates changes without granting writes', () => {
  expect(Object.keys(workflow.jobs)).toEqual([
    'warm',
    'warm-linux-arm',
    'warm-windows',
    'warm-linux-package-fixtures'
  ])
  expect(workflow.jobs.warm['timeout-minutes']).toBeLessThanOrEqual(10)
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.on.schedule).toEqual([{ cron: '41 * * * *' }])
  expect(workflow.on.pull_request.paths).toContain('.github/workflows/ci-cache-warmup.yml')
  expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  expect(workflow.concurrency.group).toContain('github.event.pull_request.number || github.ref')
  expect(steps[0].with['persist-credentials']).toBe(false)
})

it('warms and probes both Windows images with the persistence job runtime', () => {
  const job = workflow.jobs['warm-windows']
  expect(job.strategy.matrix.os).toEqual(
    NODE_SERVER_RUNNERS.filter((os) => os.startsWith('windows-'))
  )
  expect(job['runs-on']).toBe('${{ matrix.os }}')
  expect(job.strategy['fail-fast']).toBe(false)
  expect(job['timeout-minutes']).toBeLessThanOrEqual(20)
  expect(job.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  expect(job.steps[0].with['persist-credentials']).toBe(false)
  const install = job.steps.find(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  expect(install.with).toEqual({ 'native-runtime': 'node' })
  expect(job.steps.at(-1).run).toBe('node config/scripts/ensure-native-runtime.mjs --check-only')
})
