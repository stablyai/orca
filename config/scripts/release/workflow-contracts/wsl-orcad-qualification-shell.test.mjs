import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/wsl-orcad-e2e.yml', 'utf8'))
const scope = workflow.jobs.template.steps.find((step) => step.id === 'scope')

it.each([
  ['schedule', 'ubuntu-canary', ''],
  ['workflow_dispatch', 'full', ''],
  ['workflow_dispatch', '', ''],
  ['workflow_dispatch', 'ubuntu-canary', 'families=["ubuntu-24.04"]\n']
])('executes the actual scope shell for %s / %s', (name, requested, expected) => {
  const directory = mkdtempSync(join(tmpdir(), 'wsl-qualification-'))
  const output = join(directory, 'output')
  const summary = join(directory, 'summary')
  writeFileSync(output, '')
  writeFileSync(summary, '')
  try {
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-o', 'pipefail', '-c', scope.run],
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: name,
        MANUAL_QUALIFICATION: requested,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary
      }
    })
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(expected)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
