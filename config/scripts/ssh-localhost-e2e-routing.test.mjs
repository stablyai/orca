import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const workflow = parse(
  readFileSync(resolve(import.meta.dirname, '../../.github/workflows/e2e.yml'), 'utf8')
)

it('gives the localhost SSH journey its same-filesystem server and agent prerequisite', () => {
  const spec = 'tests/e2e/ssh-localhost.spec.ts'
  const job = workflow.jobs['ssh-localhost']
  expect(job.if).toContain("inputs.test_files == ''")
  expect(job.if).toContain(spec)
  expect(job['runs-on']).toBe('ubuntu-latest')
  expect(job.needs).toEqual(['build', 'prepare-native-cache'])
  const setup = job.steps.find((step) => step.name === 'Start isolated localhost SSH server')
  expect(setup.run).toContain('ListenAddress 127.0.0.1')
  expect(setup.run).toContain('PasswordAuthentication no')
  expect(setup.run).toContain('UsePAM yes')
  expect(setup.run).toContain('mkdir -p "$HOME/.pi/agent"')
  for (const key of ['ORCA_E2E_SSH_PORT', 'ORCA_E2E_SSH_USER', 'ORCA_E2E_SSH_IDENTITY_FILE']) {
    expect(setup.run).toContain(key)
  }
  const run = job.steps.find((step) => step.name === 'Run localhost SSH terminal and hook journey')
  expect(run.env.ORCA_E2E_SSH_LOCALHOST).toBe('1')
  expect(run.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS).toBe('1')
  expect(run.run).toContain(spec)
  expect(run.run).toContain('--project=electron-headless')
  expect(run.run).not.toContain('--retries')
  expect(run['continue-on-error']).toBeUndefined()
  expect(
    workflow.jobs['changed-e2e'].steps.find((step) => step.name === 'Run changed E2E specs').run
  ).toContain(`. != "${spec}"`)
})

it('selects the localhost journey for its remote hook authorities', () => {
  const spec = 'tests/e2e/ssh-localhost.spec.ts'
  for (const file of [
    'src/relay/relay-agent-hook-runtime.ts',
    'src/relay/agent-hook-server.ts',
    'src/relay/plugin-overlay.ts',
    'src/main/agent-hooks/server.ts',
    'src/main/ssh/ssh-relay-session.ts',
    'src/shared/agent-hook-relay.ts'
  ]) {
    expect(existsSync(resolve(import.meta.dirname, '../..', file)), file).toBe(true)
    expect(selectPrE2eSpecs([file])).toContain(spec)
  }
  expect(selectPrE2eSpecs(['src/renderer/src/components/Unrelated.tsx'])).not.toContain(spec)
})
