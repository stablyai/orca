import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// The rehearsal must sign and reseal the same template payload release-cut ships, or Windows reseal regressions only surface in a real release.
function readWorkflow(name) {
  return parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'))
}

const RESEAL_STEP = 'Reseal the orcad template over its signed binaries'
const release = readWorkflow('release-cut.yml').jobs.build
const { jobs } = readWorkflow('windows-signing-rehearsal.yml')
const rehearse = jobs.rehearse
const stepIndex = (name) => rehearse.steps.findIndex((step) => step.name === name)

describe('Windows signing rehearsal ships the orcad template', () => {
  it('packages the qualified template built from the dispatched commit', () => {
    expect(jobs['orcad-template'].uses).toBe('./.github/workflows/qualified-orcad-template.yml')
    expect(jobs['orcad-template'].with).toEqual({ ref: '${{ github.sha }}', fast_runners: false })
    expect(rehearse.needs).toBe('orcad-template')
    expect(rehearse.env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    const download = stepIndex('Download the orcad deployment template')
    expect(download).toBeGreaterThan(stepIndex('Build app'))
    expect(download).toBeLessThan(stepIndex('Package Windows app and export the NSIS uninstaller'))
    expect(rehearse.steps[download].with).toEqual({
      name: 'orcad-template',
      path: 'out/orcad-template'
    })
  })

  it('reseals the signed template exactly like release-cut, before the installer rebuild', () => {
    const releaseReseal = release.steps.find((step) => step.name === RESEAL_STEP)
    const reseal = stepIndex(RESEAL_STEP)
    expect(rehearse.steps[reseal].run).toBe(releaseReseal.run)
    expect(reseal).toBeGreaterThan(stepIndex('Restore signed inner binaries into unpacked app'))
    expect(reseal).toBeLessThan(stepIndex('Build NSIS installer from signed unpacked app'))
  })

  it('keeps non-Windows template addons out of SignPath staging', () => {
    const filter = "'^resources[\\\\/]orcad-template[\\\\/]targets[\\\\/](?!win32-)'"
    const staging = (job) => job.steps.find((step) => step.id === 'stage-inner').run
    expect(staging(release)).toContain(filter)
    expect(staging(rehearse)).toContain(filter)
  })
})
