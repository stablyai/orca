// Every shipped desktop package carries Windows relays, so each must stage the
// launcher-capable process-tree addon, not only the Windows packages that can compile it.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const readWorkflow = (name) =>
  parse(readFileSync(join(projectDir, '.github/workflows', name), 'utf8'))

const ARTIFACT = 'relay-windows-process-tree'
const ADDON_WORKFLOW = './.github/workflows/relay-windows-process-tree.yml'
const BUILD_BOTH_ARCHES = [
  'node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=x64',
  'node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=arm64'
]

// [workflow, packaging job, job that produces the artifact in the same run]
const DOWNLOADING_PACKAGERS = [
  ['release-cut.yml', 'build', 'relay-windows-process-tree'],
  ['hourly-mac-build.yml', 'build-hourly-mac', 'relay-windows-process-tree'],
  ['daily-mac-build.yml', 'build-daily-mac', 'relay-windows-process-tree'],
  ['adhoc-mac-build.yml', 'build-adhoc-mac', 'relay-windows-process-tree']
]

function stepIndex(job, predicate, label) {
  const index = job.steps.findIndex(predicate)
  expect(index, label).toBeGreaterThanOrEqual(0)
  return index
}

function expectRequiredBeforeBuild(job, stagingIndex) {
  const build = stepIndex(
    job,
    (step) => /pnpm (run )?build:release\b/.test(step.run ?? ''),
    'build'
  )
  expect(stagingIndex).toBeLessThan(build)
  expect(job.steps[build].env.ORCA_REQUIRE_RELAY_NATIVE_ADDONS).toBe('x64,arm64')
}

const isDownload = (step) =>
  step.uses?.startsWith('actions/download-artifact@') && step.with?.name === ARTIFACT

describe('relay Windows process-tree addon in every desktop package', () => {
  it('builds both arches once on a GitHub-hosted Windows runner and uploads them', () => {
    const job = readWorkflow('relay-windows-process-tree.yml').jobs.build
    expect(job['runs-on']).toBe('windows-2022')
    const build = job.steps.find((step) => step.name?.startsWith('Build Windows process-table'))
    expect(build.run.trim().split('\n')).toEqual(BUILD_BOTH_ARCHES)
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload.with).toMatchObject({
      name: ARTIFACT,
      path: '.build/windows-process-tree/',
      'if-no-files-found': 'error'
    })
  })

  it.each(DOWNLOADING_PACKAGERS)(
    '%s %s downloads the addons and requires them',
    (workflowName, jobName, producer) => {
      const { jobs } = readWorkflow(workflowName)
      expect(jobs[producer].uses).toBe(ADDON_WORKFLOW)
      expect([jobs[jobName].needs].flat()).toContain(producer)
      const job = jobs[jobName]
      const download = stepIndex(job, isDownload, 'download')
      expect(job.steps[download].with.path).toBe('.build/windows-process-tree')
      expectRequiredBeforeBuild(job, download)
    }
  )

  it('builds the release addons from the tag the packages are cut from', () => {
    const { jobs } = readWorkflow('release-cut.yml')
    expect(jobs[ARTIFACT].with.ref).toBe('refs/tags/${{ needs.cut.outputs.tag }}')
    // The mac build is a separate dispatched run that downloads from this one.
    expect(jobs['build-mac'].needs).toContain(ARTIFACT)
  })

  it('has the dispatched mac release build download from the release-cut run', () => {
    const job = readWorkflow('release-mac-build.yml').jobs['build-mac']
    expect(job.permissions).toMatchObject({ actions: 'read' })
    const download = stepIndex(job, isDownload, 'download')
    expect(job.steps[download].with['run-id']).toBe('${{ inputs.release_run_id }}')
    expectRequiredBeforeBuild(job, download)
  })

  it('has the dev-channel Windows build compile its own addons', () => {
    const job = readWorkflow('dev-channel-win-build.yml').jobs['build-win']
    const build = stepIndex(
      job,
      (step) => step.run?.trim().split('\n').join('\n') === BUILD_BOTH_ARCHES.join('\n'),
      'addon build'
    )
    expectRequiredBeforeBuild(job, build)
  })
})
