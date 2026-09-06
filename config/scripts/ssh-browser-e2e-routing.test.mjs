import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

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
