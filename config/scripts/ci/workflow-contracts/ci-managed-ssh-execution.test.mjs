import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'
import { managedSshShards } from '../e2e-selection/ci-e2e-job-selection.mjs'

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const lane = workflow.jobs['orcad-ssh-docker']
const command = lane.steps.find(
  (step) => step.name === 'Run managed SSH specs on a Docker host'
).run
const selector = readFileSync('config/scripts/ci/e2e-selection/ci-e2e-job-selection.mjs', 'utf8')
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function execute(input) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ssh-selection-'))
  directories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const moduleDir = join(directory, 'config', 'scripts')
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'ci-e2e-job-selection.mjs'), selector)
  writeFileSync(
    join(bin, 'xvfb-run'),
    `#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [ "$1" != pnpm ]; do shift; done
exec "$@"
`,
    { mode: 0o755 }
  )
  const capture = join(directory, 'argv.json')
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)))
`,
    { mode: 0o755 }
  )
  const result = await runProcess({
    program: 'bash',
    args: ['-e', '-o', 'pipefail', '-c', command],
    cwd: directory,
    env: {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      TEST_FILES_JSON: input,
      RUNNER_TEMP: directory,
      ARGV_CAPTURE: capture,
      SHARD: '1/1',
      LAYOUT_OWNER: '',
      SHARD_INDEX: '0'
    },
    timeoutMs: 10000
  })
  return {
    result,
    args: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : undefined
  }
}

// The production lane runs Bash on Linux; the stubs never start Docker, Electron, or Xvfb.
describe.skipIf(process.platform === 'win32')('managed SSH workflow command', () => {
  it('refuses malformed selection before starting Playwright', async () => {
    const input = 'malformed'
    const { result, args } = await execute(input)
    expect(result.code).not.toBe(0)
    expect(args).toBeUndefined()
    expect(managedSshShards(input)).toEqual(['1/2', '2/2'])
  })
})
