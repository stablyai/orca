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

describe('dev-channel Windows build wiring', () => {
  it.each(MAC_WORKFLOWS)(
    'calls the shared Windows workflow from %s with its own channel',
    (channel, path, jobName) => {
      const jobs = readWorkflow(path).jobs
      const winJob = jobs[`build-${channel}-win`]

      expect(winJob).toBeDefined()
      expect(winJob.uses).toBe('./.github/workflows/dev-channel-win-build.yml')
      expect(winJob.with.channel).toBe(channel)
      // Why `./` and not a pinned @main: `uses:` resolves against the ref this
      // workflow file came from, which for an ordinary dispatch is main. A branch
      // deliberately selected in the Actions picker already supplies its own copy
      // of the whole file, so this follows that rule rather than adding a second.
      expect(winJob.uses.startsWith('./')).toBe(true)
      expect(winJob.needs).toBe(jobName)
      expect(winJob.secrets).toBe('inherit')
    }
  )

  // Why gated on published: the Windows leg uploads into a release the mac leg
  // created, and refuses to create one itself. Without this it would run for a
  // tag that was never published — or, for hourly, for a run that skipped.
  it.each(MAC_WORKFLOWS)(
    'only runs the %s Windows leg once the release is live',
    (channel, path, jobName) => {
      expect(readWorkflow(path).jobs[`build-${channel}-win`].if).toBe(
        `needs.${jobName}.outputs.published == 'true'`
      )
    }
  )

  // The Windows job names the release by consuming these; a renamed step id
  // would silently resolve them to empty strings and upload nowhere.
  it.each(MAC_WORKFLOWS)(
    'exposes the %s tag, version and commit as job outputs',
    (_c, path, jobName) => {
      const job = readWorkflow(path).jobs[jobName]
      const stepIds = job.steps.map((step) => step.id).filter(Boolean)

      for (const key of ['tag', 'version', 'head_sha', 'published']) {
        expect(job.outputs[key]).toBeTruthy()
      }
      // Every referenced step id must actually exist in the job.
      for (const expression of Object.values(job.outputs)) {
        const referenced = [...expression.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1])
        for (const id of referenced) {
          expect(stepIds).toContain(id)
        }
      }
    }
  )

  // Why this is asserted: the previous design dispatched a sibling run, which
  // needed actions:write on a job holding macOS signing credentials. Calling the
  // workflow directly removes that, and it must not creep back.
  it.each(MAC_WORKFLOWS)(
    'does not widen the %s signing job to actions:write',
    (_c, path, jobName) => {
      expect(readWorkflow(path).jobs[jobName].permissions?.actions).toBeUndefined()
    }
  )
})

describe('dev-channel Windows build workflow', () => {
  it('is both callable by the mac workflows and dispatchable on its own', () => {
    const triggers = winWorkflow().on ?? winWorkflow()[true]

    expect(Object.keys(triggers)).toEqual(
      expect.arrayContaining(['workflow_call', 'workflow_dispatch'])
    )
    // workflow_call cannot express `type: choice`, so the channel set has to be
    // enforced in the job itself.
    expect(stepNamed(winSteps(), 'Vet the requested inputs').run).toContain('hourly|daily|adhoc')
  })

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

  // Why: this is callable and separately dispatchable, and workflow_call takes
  // its inputs as free text, so it re-derives the ref guarantee rather than
  // trusting whoever called it.
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
