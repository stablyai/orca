import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

it('publishes conservative hints for malformed evidence and refuses a malformed consumer list', async () => {
  const program = 'config/scripts/ci/e2e-selection/ci-e2e-job-selection.mjs'
  const consumer = await runProcess({
    program: process.execPath,
    args: [program],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(consumer.code).not.toBe(0)
  const hints = await runProcess({
    program: process.execPath,
    args: [program, '--job-outputs'],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(hints.code, hints.stderr).toBe(0)
  expect(hints.stdout).toBe(
    'e2e_run_changed=true\ne2e_needs_build=true\ne2e_ssh_shards=["1/2","2/2"]\n'
  )
})
