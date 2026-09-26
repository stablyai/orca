import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const readWorkflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
const workflow = readWorkflow('ci-cache-warmup')
const steps = workflow.jobs.warm.steps

it('warms the same Linux Node runtime the PR shards restore', () => {
  const install = steps.find((step) => step.uses === './.github/actions/install-node-dependencies')
  const primer = readWorkflow('pr').jobs.test_native_cache
  expect(workflow.jobs.warm['runs-on']).toBe(primer['runs-on'])
  expect(install.with).toEqual(primer.steps.find((step) => step.uses === install.uses).with)
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

it('bounds warming to one hosted job and validates changes without granting writes', () => {
  expect(Object.keys(workflow.jobs)).toEqual(['warm'])
  expect(workflow.jobs.warm['timeout-minutes']).toBeLessThanOrEqual(10)
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.on.schedule).toEqual([{ cron: '41 * * * *' }])
  expect(workflow.on.pull_request.paths).toContain('.github/workflows/ci-cache-warmup.yml')
  expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  expect(workflow.concurrency.group).toContain('github.event.pull_request.number || github.ref')
  expect(steps[0].with['persist-credentials']).toBe(false)
})
