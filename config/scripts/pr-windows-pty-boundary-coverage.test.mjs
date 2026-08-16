import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('Windows PTY boundary coverage', () => {
  it('runs cross-platform Codex resume path tests on Windows', () => {
    const testStep = workflow.jobs.package_windows.steps.find(
      (step) => step.name === 'Test Windows-specific boundaries'
    )

    expect(testStep.run).toContain('src/main/ipc/pty-codex-account-attribution.test.ts')
    expect(testStep.run).toContain('src/main/ipc/pty-spawn-env-codex-resume-provenance.test.ts')
  })
})
