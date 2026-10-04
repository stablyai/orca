import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const pr = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const mobile = parse(readFileSync('.github/workflows/mobile.yml', 'utf8'))
const cloud = parse(readFileSync('.github/workflows/cloud-verify.yml', 'utf8'))
const headless = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))

function assertJoinedBefore(steps, id, consumer) {
  const start = steps.findIndex((step) => step.id === id)
  const join = steps.findIndex((step) => [step.wait].flat().includes(id))
  const end = steps.findIndex(consumer)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(steps[start].background).toBe(true)
  expect(join).toBeGreaterThan(start)
  expect(end).toBeGreaterThan(join)
}

describe('CI background step barriers', () => {
  it('joins every background check without suppressing failures', () => {
    for (const job of [
      pr.jobs.preflight,
      pr.jobs.mobile_web_app,
      pr.jobs.package,
      pr.jobs.shell_contracts,
      mobile.jobs.verify,
      cloud.jobs.security,
      headless.jobs.persistence
    ]) {
      const pending = new Set()
      for (const step of job.steps) {
        if (step.background) {
          expect(step.id).toBeTruthy()
          expect(pending.has(step.id)).toBe(false)
          expect(step['continue-on-error']).toBeUndefined()
          pending.add(step.id)
        }
        if (step.wait) {
          expect(step.if).toBeUndefined()
          expect(step['continue-on-error']).toBeUndefined()
          for (const id of [step.wait].flat()) {
            expect(pending.delete(id), `missing background step ${id}`).toBe(true)
          }
        }
        expect(pending.size).toBeLessThanOrEqual(job === pr.jobs.package ? 4 : 3)
      }
      expect([...pending]).toEqual([])
    }
  })

  it('joins planning before publishing the unit artifact', () => {
    assertJoinedBefore(
      pr.jobs.preflight.steps,
      'unit-plan',
      (step) => step.uses === 'actions/upload-artifact@v7'
    )
  })

  it('joins the Linux Bun build before requiring both headless runtime artifacts', () => {
    const steps = headless.jobs.persistence.steps
    const consumer = (step) => step.run?.startsWith('pnpm test:node-server --artifact ')
    assertJoinedBefore(steps, 'bun-orcad', consumer)
    const start = steps.findIndex((step) => step.id === 'bun-orcad')
    const join = steps.findIndex((step) => step.wait === 'bun-orcad')
    const install = steps.findIndex((step) => step.uses?.endsWith('/install-node-dependencies'))
    const setup = steps.findIndex((step) => step.uses?.startsWith('oven-sh/setup-bun@'))
    expect(install).toBeGreaterThanOrEqual(0)
    expect(setup).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(setup)
    expect(setup).toBeLessThan(start)
    expect(steps[setup].if).toBe("runner.os == 'Linux'")
    expect(steps[start].if).toBeUndefined()
    expect(steps[start].run).toContain('if [ "$RUNNER_OS" != Linux ]; then exit 0; fi')
    for (const build of [
      steps.findIndex((step) => step.uses?.endsWith('/prepare-orcad-prebuilds')),
      steps.findIndex((step) => step.run === 'pnpm build:orcad')
    ]) {
      expect(build).toBeGreaterThan(start)
      expect(build).toBeLessThan(join)
      expect(steps[build].background).toBeUndefined()
    }
    const test = steps.find(consumer)
    expect(test.run).toContain("${{ runner.os == 'Linux' && '--cross-runtime' || '' }}")
    expect(test.env.ORCA_BUN_ORCAD_SLOT).toBe('${{ steps.bun-orcad.outputs.slot }}')
    expect(test.env.BUN_EXECUTABLE).toBe('${{ steps.bun-orcad.outputs.executable }}')
  })

  it('finishes native import-cycle analysis before mobile installation changes resolution', () => {
    const steps = pr.jobs.preflight.steps
    assertJoinedBefore(steps, 'native-code-quality', (step) =>
      step.uses?.endsWith('/install-mobile-dependencies')
    )
    const install = steps.findIndex((step) => step.uses?.endsWith('/install-mobile-dependencies'))
    expect(steps[install].background).toBeUndefined()
    expect(steps.findIndex((step) => step.id === 'changed-code-quality')).toBeGreaterThan(install)
  })

  it('serializes mobile pnpm entrypoints before allocating test workers', () => {
    const steps = mobile.jobs.verify.steps
    assertJoinedBefore(steps, 'production-types', (step) => step.name === 'Test')
    const ratchet = steps.findIndex((step) => step.name === 'Typecheck tests (ratchet)')
    const join = steps.findIndex((step) => step.wait === 'production-types')
    expect(steps[ratchet].background).toBeUndefined()
    expect(ratchet).toBeGreaterThan(join)
  })

  it('waits for WebKit and the bundle before any browser tests', () => {
    const steps = pr.jobs.mobile_web_app.steps
    assertJoinedBefore(
      steps,
      'webkit',
      (step) => step.name === 'Builder, override census and render checks'
    )
    const build = steps.findIndex((step) => step.name === 'Build and verify the app bundle')
    expect(steps[build].background).toBeUndefined()
    expect(build).toBeLessThan(steps.findIndex((step) => [step.wait].flat().includes('webkit')))
    expect(steps.findIndex((step) => step.id === 'webkit')).toBeLessThan(build)
  })

  it('joins shell installation before checking fish and running live shell tests', () => {
    const steps = pr.jobs.shell_contracts.steps
    assertJoinedBefore(steps, 'shells', (step) => step.name === 'Require fish 4+')
    assertJoinedBefore(steps, 'shells', (step) => step.name === 'Test real shell contracts')
    const install = steps.findIndex((step) => step.uses?.endsWith('/install-node-dependencies'))
    expect(install).toBeGreaterThan(steps.findIndex((step) => step.id === 'shells'))
    expect(install).toBeLessThan(steps.findIndex((step) => step.wait === 'shells'))
  })

  it('prepares fresh mobile routes after dependencies and before the browser tests', () => {
    const steps = pr.jobs.mobile_web_app.steps
    assertJoinedBefore(
      steps,
      'mobile-routes',
      (step) => step.name === 'Builder, override census and render checks'
    )
    const prepare = steps.findIndex((step) => step.id === 'mobile-routes')
    expect(prepare).toBeGreaterThan(
      steps.findIndex((step) => step.uses?.endsWith('/install-mobile-dependencies'))
    )
    expect(prepare).toBeLessThan(
      steps.findIndex((step) => step.name === 'Build and verify the app bundle')
    )
  })

  it('joins package setup before reading outputs and preserves isolated native probes', () => {
    const steps = pr.jobs.package.steps
    // Parallel composites must not race to download their shared cache action on first use.
    const cacheAction = steps.findIndex((step) => step.uses === 'actions/cache/restore@v5')
    expect(cacheAction).toBeGreaterThanOrEqual(0)
    expect(cacheAction).toBeLessThan(
      steps.findIndex((step) => step.id === 'shutdown-fixture-cache')
    )
    for (const [id, consumer] of [
      ['linux-package-tools', 'Package unpacked app'],
      ['web-client', 'Package unpacked app'],
      ['shutdown-fixture-cache', 'Verify headless serve signal shutdown'],
      ['cli-fixture-cache', 'Verify Linux CLI launch contract']
    ]) {
      assertJoinedBefore(steps, id, (step) => step.name === consumer)
      expect(steps.findIndex((step) => step.id === id)).toBeGreaterThan(
        steps.findIndex((step) => step.name === 'Test Linux Electron lifecycle boundary')
      )
    }
  })

  it('joins digest-pinned scanner downloads and the history scan without hiding failures', () => {
    const steps = cloud.jobs.security.steps
    const history = steps.findIndex((step) => step.name === 'Fetch complete scan history')
    for (const [id, imageName] of [
      ['gitleaks-image', 'gitleaks'],
      ['trufflehog-image', 'trufflehog']
    ]) {
      const download = steps.find((step) => step.id === id)
      const scan = steps.find(
        (step) => step.run?.includes('docker run') && step.run.includes(imageName)
      )
      const digestImage = scan.run.match(/\S+@sha256:[a-f0-9]{64}/)[0]
      expect(download.run).toBe(`docker pull ${digestImage}`)
      expect(steps.indexOf(download)).toBeLessThan(history)
      assertJoinedBefore(steps, id, (step) => step === scan)
      expect(steps.indexOf(scan)).toBeGreaterThan(history)
      expect(scan.run).toContain('/repo:ro')
    }
    expect(steps.at(-1).wait).toBe('history-scan')
  })
})
