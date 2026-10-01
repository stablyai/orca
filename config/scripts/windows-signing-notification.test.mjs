import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const releaseSteps = () =>
  parse(readFileSync(new URL('../../.github/workflows/release-cut.yml', import.meta.url), 'utf8'))
    .jobs.build.steps
const stepNamed = (steps, name) => steps.find((step) => step.name === name)

describe('Windows signing failure notification', () => {
  it('alerts Slack after signing failures without masking the release failure', () => {
    const steps = releaseSteps()
    const notify = stepNamed(steps, 'Notify Slack when Windows signing fails')
    const names = steps.map((step) => step.name)
    expect(stepNamed(steps, 'Install SignPath PowerShell module').id).toBe('install-signpath')
    expect(notify.if).toBe(
      "failure() && matrix.platform == 'win' && github.run_attempt == 1 && steps.install-signpath.outcome != '' && steps.install-signpath.outcome != 'skipped'"
    )
    expect(notify['continue-on-error']).toBe(true)
    expect(names.indexOf(notify.name)).toBeGreaterThan(
      names.indexOf('Verify Windows inner binary signatures')
    )
    expect(names.indexOf(notify.name)).toBeLessThan(
      names.indexOf('Publish signed Windows release artifacts')
    )
    expect(notify.env.SLACK_WEBHOOK_URL).toBe('${{ secrets.SLACK_WEBHOOK_URL }}')
    expect(notify.env.INNER_REQUEST_ID).toContain(
      'steps.submit-inner-signing.outputs.signing-request-id'
    )
    expect(notify.env.INSTALLER_REQUEST_ID).toContain(
      'steps.submit-signing-request.outputs.signing-request-id'
    )
    expect(notify.run).toContain('Publication is blocked.')
    expect(notify.run).toContain('Late SignPath approval does not resume this run')
    expect(notify.run).toContain('Invoke-RestMethod -Method Post')
  })
})
