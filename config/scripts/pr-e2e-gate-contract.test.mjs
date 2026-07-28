import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

const filterStep = prWorkflow.jobs['e2e-paths'].steps.find(
  (step) => step.name === 'Filter E2E-relevant paths'
)
const verifyStep = prWorkflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)

describe('PR E2E gate contract', () => {
  it('keeps E2E advisory while the suite is red on main', () => {
    // Why: pin the deliberate choice so it reads as intentional rather than as
    // the "forgot to wire the gate" bug this file originally caught. Gating on a
    // suite that fails every scheduled run would block the PRs that fix it.
    // Flipping to blocking means updating this expectation too — see the comment
    // on verify's Require-successful-checks step for the exact wiring.
    expect(prWorkflow.jobs.verify.needs).not.toContain('e2e')
    expect(verifyStep.env.E2E).toBeUndefined()
    expect(verifyStep.run).not.toContain('$E2E')
  })

  it('runs E2E only when the detector says the PR touches E2E paths', () => {
    // Why: without this the job could lose its filter and run on every PR — the
    // cost the path filter exists to avoid — while the gate assertions above
    // stay green.
    expect(prWorkflow.jobs.e2e.needs).toBe('e2e-paths')
    expect(prWorkflow.jobs.e2e.if).toBe("needs.e2e-paths.outputs.should_run == 'true'")
    expect(prWorkflow.jobs['e2e-paths'].outputs.should_run).toBe(
      '${{ steps.filter.outputs.should_run }}'
    )
  })

  it('enforces every job verify depends on', () => {
    // Why: derive from verify.needs rather than hardcoding, so adding a required
    // job without adding it to the strict loop fails here instead of silently
    // leaving that job unenforced. This is what caught GIT_COMPATIBILITY and
    // SHELL_CONTRACTS being absent from an earlier hardcoded list.
    const strictLoop = verifyStep.run.slice(0, verifyStep.run.indexOf('done'))
    for (const job of prWorkflow.jobs.verify.needs) {
      const envVar = job.toUpperCase()
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.${job}.result }}`)
      expect(strictLoop).toContain(`"$${envVar}"`)
    }
  })

  it('matches the Playwright config where it actually lives', () => {
    // Why: the config is tests/playwright.config.ts, beside tests/e2e/ rather
    // than inside it. A bare `playwright.` prefix matches no tracked file, so
    // editing the runner config would silently skip E2E.
    expect(filterStep.run).toContain('tests/playwright\\.')
    expect(filterStep.run).not.toMatch(/\(\^?\|\|]tests\/e2e\/\|playwright\\\./)
  })

  it('scopes detection to the PR range so base drift cannot false-trigger', () => {
    expect(filterStep.run).toContain('git diff --name-only --merge-base "$BASE" "$HEAD"')
    expect(filterStep.run).toContain('set -euo pipefail')
  })
})
