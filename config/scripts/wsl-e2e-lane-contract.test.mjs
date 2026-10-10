import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hasWslSourceChange, selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('real WSL terminal lane', () => {
  it.each([
    'config/scripts/verify-wsl-e2e-participation.mjs',
    'config/scripts/verify-playwright-participation.mjs',
    'src/main/wsl-availability.ts',
    'src/main/wsl/wsl-runner.ts',
    'src/main/pty/wsl-orca-env.ts',
    'src/shared/wsl-login-shell-command.ts',
    'src/shared/windows-terminal-shell.ts',
    'tests/e2e/helpers/wsl-golden-stub-agent.ts',
    'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
    'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts',
    '.github/actions/setup-wsl-test-runtime/setup.ps1',
    '.github/workflows/windows-wsl-e2e.yml'
  ])('routes %s to both WSL sentinels', (path) => {
    expect(hasWslSourceChange([path])).toBe(true)
    expect(selectPrE2eSpecs([path])).toEqual(
      expect.arrayContaining([
        'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
        'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts'
      ])
    )
  })

  it.each([
    'docs/reference/wsl-command-execution.md',
    'src/main/wsl-availability.test.ts',
    'src/main/ssh/connection.ts'
  ])('excludes unrelated or unit-only change %s', (path) => {
    expect(hasWslSourceChange([path])).toBe(false)
  })

  it('runs the reusable lane at the immutable PR head', () => {
    const pr = parse(read('.github/workflows/pr.yml'))
    expect(pr.jobs.windows_wsl.if).toBe("needs.code_paths.outputs.wsl_source_changed == 'true'")
    expect(pr.jobs.windows_wsl.with.ref).toBe('${{ github.event.pull_request.head.sha }}')
    const detector = pr.jobs['code_paths'].steps.find(
      (step) => step.name === 'Filter changed E2E specs'
    )
    expect(detector.run).toContain(
      'WSL_CHANGED="$(git diff --name-only --no-renames --diff-filter=ACDMR'
    )
    expect(detector.run).toContain(
      '"$WSL_CHANGED" | node config/scripts/pr-e2e-source-routing.mjs --wsl-source'
    )
    const workflow = parse(read('.github/workflows/windows-wsl-e2e.yml'))
    const steps = workflow.jobs['wsl-terminal'].steps
    expect(steps[0].with.ref).toBe('${{ inputs.ref || github.sha }}')
    expect(steps.some((step) => step.uses === './.github/actions/setup-wsl-test-runtime')).toBe(
      true
    )
    const exercise = steps.find((step) => step.name === 'Exercise real WSL launch and paste')
    expect(exercise.run.split(/\s+/).filter((arg) => arg.startsWith('--repeat-each='))).toEqual([
      '--repeat-each=3'
    ])
    expect(exercise.run).toContain('--grep "WSL"')
    const receipt = steps.find((step) => step.name === 'Require all nine WSL executions')
    expect(receipt.if).toBe('always()')
    expect(receipt.run).toBe(
      'node config/scripts/verify-wsl-e2e-participation.mjs test-results/wsl-results.json'
    )
  })
})
