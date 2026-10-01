import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

function readWorkflow(name) {
  return parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'))
}

const LANES = ['persistence', 'linux_glibc_floor', 'linux_glibc217_compat', 'linux_musl']

function stepIndex(steps, predicate) {
  const index = steps.findIndex(predicate)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

describe('orcad template release wiring (design D2)', () => {
  const nodeServer = readWorkflow('node-server-tests.yml')
  const releaseCut = readWorkflow('release-cut.yml')
  const releaseMac = readWorkflow('release-mac-build.yml')

  it('builds the template from the slots the node-server lanes qualified at the release ref', () => {
    expect(nodeServer.on.workflow_call.inputs).toMatchObject({
      ref: { type: 'string' },
      build_template: { type: 'boolean', default: false }
    })
    // A release call shares github.ref with main's push runs; neither may cancel the other.
    expect(nodeServer.concurrency['cancel-in-progress']).toBe('${{ !inputs.build_template }}')
    expect(nodeServer.concurrency.group).toContain('github.run_id')
    for (const lane of LANES) {
      const steps = nodeServer.jobs[lane].steps
      const checkout = steps.find((step) => step.uses === 'actions/checkout@v6')
      expect(checkout.with.ref).toBe('${{ inputs.ref }}')
      const upload = steps.find(
        (step) =>
          step.uses === 'actions/upload-artifact@v7' &&
          String(step.with.name).startsWith('orcad-prebuild-')
      )
      expect(upload.if).toContain('inputs.build_template')
      expect(upload.with.path).toBe('out/orcad-prebuilds/')
      // A rerun of a flaky lane must be able to replace its earlier attempt's slot.
      expect(upload.with.overwrite).toBe(true)
      // Only qualified slots: the upload follows the lane's own gates and tests.
      const gates = steps.filter((step) => /require-slots|test:node-server/.test(step.run ?? ''))
      expect(gates.length).toBeGreaterThan(0)
      for (const gate of gates) {
        expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(gate))
      }
    }

    // The addon build script imports TypeScript, which the lane's later Node 18 check cannot load.
    const persistence = nodeServer.jobs.persistence.steps
    const addons = stepIndex(
      persistence,
      (step) => step.name === 'Build the Windows process-table addons for the desktop template'
    )
    const node18 = stepIndex(persistence, (step) => step.with?.['node-version'] === '18')
    expect(addons).toBeLessThan(node18)

    const template = nodeServer.jobs.desktop_template
    expect(template.needs).toEqual(LANES)
    for (const lane of LANES) {
      expect(template.if).toContain(`needs.${lane}.result == 'success'`)
    }
    const run = template.steps.map((step) => step.run ?? '').join('\n')
    expect(run).toContain('merge-orcad-prebuilds.mjs "$RUNNER_TEMP"/orcad-prebuild-lanes/*')
    expect(run).toContain('pnpm build:orcad-prebuilds --require-slots\n')
    expect(run).toContain('pnpm build:orcad-prebuilds --require-slots linux-x64-glibc217')
    expect(run).toContain('pnpm build:orcad-template')
    const upload = template.steps.find((step) => step.uses === 'actions/upload-artifact@v7')
    expect(upload.with).toMatchObject({
      name: 'orcad-template',
      path: 'out/orcad-template/',
      'include-hidden-files': true,
      overwrite: true
    })
  })

  it('makes every desktop release package wait for, download and require the template', () => {
    const job = releaseCut.jobs['orcad-template']
    expect(job.uses).toBe('./.github/workflows/node-server-tests.yml')
    expect(job.with).toEqual({
      ref: 'refs/tags/${{ needs.cut.outputs.tag }}',
      build_template: true
    })
    for (const name of ['build', 'build-mac']) {
      expect(releaseCut.jobs[name].needs).toContain('orcad-template')
    }
    const build = releaseCut.jobs.build
    expect(build.env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    const download = stepIndex(
      build.steps,
      (step) => step.name === 'Download the orcad deployment template'
    )
    expect(build.steps[download].with).toEqual({
      name: 'orcad-template',
      path: 'out/orcad-template'
    })
    const packaging = build.steps.filter((step) =>
      /electron-builder|release_command/.test(`${step.run ?? ''}${step.with?.command ?? ''}`)
    )
    expect(packaging.length).toBeGreaterThan(0)
    for (const step of packaging) {
      expect(build.steps.indexOf(step)).toBeGreaterThan(download)
    }

    const macSteps = releaseMac.jobs['build-mac'].steps
    // Why by name: the mac job also downloads the relay Windows process-tree addons.
    const macDownload = stepIndex(
      macSteps,
      (step) => step.uses === 'actions/download-artifact@v8' && step.with?.name === 'orcad-template'
    )
    expect(macSteps[macDownload].with).toMatchObject({
      name: 'orcad-template',
      path: 'out/orcad-template',
      'run-id': '${{ inputs.release_run_id }}'
    })
    const publish = stepIndex(macSteps, (step) => step.name === 'Publish release artifacts (macOS)')
    expect(publish).toBeGreaterThan(macDownload)
    expect(macSteps[publish].env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    expect(releaseMac.permissions.actions).toBe('read')
  })

  it('signs only Windows template binaries and reseals the manifest before the installer rebuild', () => {
    const steps = releaseCut.jobs.build.steps
    const stage = steps.find((step) => step.id === 'stage-inner')
    expect(stage.run).toContain("orcad-template[\\\\/]targets[\\\\/](?!win32-)')")
    const restore = stepIndex(steps, (step) => step.id === 'restore-signed-inner')
    const reseal = stepIndex(steps, (step) => step.id === 'reseal-orcad-template')
    const rebuild = stepIndex(steps, (step) => step.id === 'rebuild-nsis-signed')
    expect(restore).toBeLessThan(reseal)
    expect(reseal).toBeLessThan(rebuild)
    expect(steps[reseal].run).toBe(
      'node config/scripts/packaged-orcad-template.cjs --reseal-signed dist/win-unpacked inner-signing-list.txt'
    )
  })
})
