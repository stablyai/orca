import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const root = resolve(import.meta.dirname, '../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/e2e.yml'), 'utf8'))
const runner = readFileSync(join(root, 'config/scripts/run-ssh-docker-e2e.mjs'), 'utf8')

it('routes SSH browser specs to a lane that enables their opt-ins', () => {
  const changedRun = workflow.jobs['changed-e2e'].steps.find(
    (step) => step.name === 'Run changed E2E specs'
  )
  for (const [spec, flag] of [
    ['tests/e2e/local-ssh-browser-routing.spec.ts', 'ORCA_E2E_LOCAL_SSH_BROWSER'],
    [
      'tests/e2e/ssh-client-hosted-browser-drop-reconnect.spec.ts',
      'ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER'
    ]
  ]) {
    expect(runner).toContain(`'${spec}'`)
    expect(runner).toContain(`${flag}: '1'`)
    expect(workflow.jobs['ssh-docker-watcher-isolation'].if).toContain(spec)
    expect(changedRun.run).toContain(`. != "${spec}"`)
  }
})

it('executes both Docker network routes in a Node job with their opt-in enabled', () => {
  const spec = 'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
  const job = workflow.jobs['ssh-browser-network-route']
  const install = job.steps.find(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  const run = job.steps.find(
    (step) => step.name === 'Run Docker SSH browser network route journeys'
  )
  expect(job['runs-on']).toBe('ubuntu-latest')
  expect(job.if).toContain("inputs.test_files == ''")
  expect(job.if).toContain(spec)
  expect(install.with['native-runtime']).toBe('node')
  expect(run.env.ORCA_RUN_DOCKER_SSH_BROWSER_E2E).toBe('1')
  expect(run.run).toContain(`vitest run --config config/vitest.config.ts ${spec}`)
  expect(run['continue-on-error']).toBeUndefined()
  expect(
    workflow.jobs['changed-e2e'].steps.find((step) => step.name === 'Run changed E2E specs').run
  ).toContain(`. != "${spec}"`)
  for (const changed of [
    spec,
    'src/main/browser/ssh-browser-network-execution-route.ts',
    'src/main/browser/browser-network-deferred-socket.ts',
    'src/main/browser/browser-network-execution-route.ts',
    'src/main/browser/system-ssh-socks-client-socket.ts',
    'src/main/ssh/system-ssh-dynamic-forward-process.ts',
    'tests/e2e/helpers/docker-ssh-relay-target.ts',
    'tests/e2e/helpers/docker-ssh-relay-image.ts'
  ]) {
    expect(selectPrE2eSpecs([changed])).toContain(spec)
  }
  expect(selectPrE2eSpecs(['src/renderer/src/components/Unrelated.tsx'])).not.toContain(spec)
  expect(selectPrE2eSpecs(['tests/e2e/helpers/docker-ssh-relay-terminal-tabs.ts'])).not.toContain(
    spec
  )
})
