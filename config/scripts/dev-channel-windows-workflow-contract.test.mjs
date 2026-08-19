import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

const MAC_WORKFLOWS = [
  ['hourly', '.github/workflows/hourly-mac-build.yml', 'build-hourly-mac'],
  ['daily', '.github/workflows/daily-mac-build.yml', 'build-daily-mac'],
  ['adhoc', '.github/workflows/adhoc-mac-build.yml', 'build-adhoc-mac']
]

const winWorkflow = () => readWorkflow('.github/workflows/dev-channel-win-build.yml')
const winSteps = () => winWorkflow().jobs['build-win'].steps
const stepNamed = (steps, name) => steps.find((step) => step.name === name)

describe('dev-channel Windows build dispatch', () => {
  it.each(MAC_WORKFLOWS)(
    'dispatches the Windows build from the %s workflow with its own channel',
    (channel, path, jobName) => {
      const job = readWorkflow(path).jobs[jobName]
      const dispatch = stepNamed(job.steps, 'Dispatch the Windows build')

      expect(dispatch).toBeDefined()
      expect(dispatch.run).toContain('gh workflow run dev-channel-win-build.yml')
      expect(dispatch.run).toContain(`--raw-field channel=${channel}`)
      // Why --ref main: the Windows workflow definition must come from main, so a
      // stale copy on the branch an adhoc build targets can never be what runs.
      expect(dispatch.run).toContain('--ref main')
    }
  )

  // Why before packaging: dispatching after the mac artifacts are built would
  // serialise the two legs and hand the channel the Windows build's wall-clock.
  it.each(MAC_WORKFLOWS)(
    'dispatches %s after the release exists but before the mac build',
    (channel, path, jobName) => {
      const names = readWorkflow(path).jobs[jobName].steps.map((step) => step.name)
      const create = names.indexOf(`Create ${channel} release`)
      const dispatch = names.indexOf('Dispatch the Windows build')
      const publish = names.indexOf(`Publish ${channel} macOS artifacts`)

      expect(create).toBeGreaterThanOrEqual(0)
      expect(dispatch).toBeGreaterThan(create)
      expect(publish).toBeGreaterThan(dispatch)
    }
  )

  // Why: Windows is additive. A dispatch failure must degrade the release to
  // "macOS only", which the picker already handles by filtering on assets, and
  // never cost a signed mac build that has already been paid for.
  it.each(MAC_WORKFLOWS)('never fails the %s mac build on a dispatch error', (_c, path, job) => {
    const dispatch = stepNamed(readWorkflow(path).jobs[job].steps, 'Dispatch the Windows build')

    expect(dispatch['continue-on-error']).toBe(true)
  })

  it.each(MAC_WORKFLOWS)('grants the %s job the actions:write the dispatch needs', (_c, p, job) => {
    expect(readWorkflow(p).jobs[job].permissions).toMatchObject({
      contents: 'read',
      actions: 'write'
    })
  })
})

describe('dev-channel Windows build workflow', () => {
  // Why windows-2022: windows-latest moved to the Windows 2025 / VS 2026 image
  // before node-gyp could detect VS 18, breaking native dependency install.
  it('pins the same Windows image release-cut builds on', () => {
    expect(winWorkflow().jobs['build-win']['runs-on']).toBe('windows-2022')
  })

  // The guard against a branch whose electron-builder config predates Windows
  // dev builds: without it, publish.repo resolves to the main repo.
  it('verifies the dev-channel packaging identity before building', () => {
    const steps = winSteps()
    const names = steps.map((step) => step.name)
    const verify = names.indexOf('Verify dev-channel packaging identity')
    const build = names.indexOf('Build app')

    expect(verify).toBeGreaterThanOrEqual(0)
    expect(build).toBeGreaterThan(verify)
    expect(stepNamed(steps, 'Verify dev-channel packaging identity').run).toContain(
      'verify-dev-channel-packaging.mjs'
    )
  })

  // Why: electron-publish creates a release when it cannot find the tag under
  // `--publish always`. If the mac leg discarded its draft while this was
  // building, that would mint an untitled Windows-only release.
  it('confirms the target release exists before publishing into it', () => {
    const names = winSteps().map((step) => step.name)
    const confirm = names.indexOf('Confirm the target release still exists')
    const publish = names.indexOf('Publish Windows artifacts')

    expect(confirm).toBeGreaterThanOrEqual(0)
    expect(publish).toBeGreaterThan(confirm)
  })

  // electron-publish refuses to upload into a release published more than two
  // hours ago. The mac leg publishes as soon as it finishes, so a slow notary
  // queue plus a slow Windows build crosses that line and drops every asset.
  it('opts out of the publisher two-hour upload window', () => {
    expect(stepNamed(winSteps(), 'Publish Windows artifacts').env.EP_GH_IGNORE_TIME).toBe('true')
  })

  it('packages Windows unsigned through the shared electron-builder config', () => {
    const publish = stepNamed(winSteps(), 'Publish Windows artifacts')

    expect(publish.with.command).toContain(
      'electron-builder --config config/electron-builder.config.cjs --win --publish always'
    )
    // No signing env: SignPath's approval waits cannot fit a dev cadence, which
    // is the entire reason these builds are unsigned.
    expect(Object.keys(publish.env)).not.toContain('SIGNPATH_API_TOKEN')
  })

  // Why both: a release carrying the installer but not the manifest is a row the
  // picker offers and the in-app update 404s on.
  it('requires the manifest and the installer before calling the build good', () => {
    const verify = stepNamed(winSteps(), 'Verify Windows update manifest published')

    expect(verify.run).toContain('latest.yml')
    expect(verify.run).toContain('orca-windows-setup.exe')
  })

  // Why: this workflow is dispatchable on its own, so it re-derives the ref
  // guarantee rather than trusting whoever called it.
  it('vets the requested commit before checking it out', () => {
    const names = winSteps().map((step) => step.name)
    const vet = names.indexOf('Vet the requested inputs')
    const checkout = names.indexOf('Checkout the built commit')

    expect(vet).toBe(0)
    expect(checkout).toBeGreaterThan(vet)
    expect(stepNamed(winSteps(), 'Vet the requested inputs').run).toContain('--contains')
  })

  // Telemetry's transport gate accepts only 'stable' or 'rc'; leaving the build
  // identity unset is what keeps unvetted artifacts silent.
  it('never stamps an official telemetry build identity', () => {
    const build = stepNamed(winSteps(), 'Build app')

    expect(Object.keys(build.env ?? {})).not.toContain('ORCA_BUILD_IDENTITY')
  })
})
