import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

function workflow(name) {
  return parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
}

function evaluate(source, context) {
  return runInNewContext(
    source
      .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/needs\.([a-z][a-z-]*)/g, (_match, name) => `needs["${name}"]`),
    { cancelled: () => false, github: { repository: 'stablyai/orca' }, ...context }
  )
}

function needs(ships = 'true', result = 'success') {
  return {
    preflight: { outputs: { should_build: 'true' } },
    'relay-windows-process-tree': { result: 'success' },
    'orcad-template-support': { result: 'success', outputs: { ships } },
    'orcad-template': { result }
  }
}

function downloadStep(build) {
  return build.steps.find((step) => step.with?.name === 'orcad-template')
}

function packagingStep(build) {
  return build.steps.find((step) => step.with?.command?.includes('electron-builder --config'))
}

describe.each(['hourly', 'daily'])('%s managed SSH packaging', (channel) => {
  const { jobs } = workflow(`${channel}-mac-build`)
  const build = jobs[`build-${channel}-mac`]

  it('qualifies and ships the same commit on macOS and Windows', () => {
    const pinned = '${{ needs.preflight.outputs.head_sha }}'
    for (const name of ['relay-windows-process-tree', 'orcad-template']) {
      expect(jobs[name].with.ref).toBe(pinned)
      expect(jobs[name].permissions).toEqual({ contents: 'read' })
    }
    expect(jobs['orcad-template'].uses).toBe('./.github/workflows/node-server-tests.yml')
    expect(jobs['orcad-template'].with.build_template).toBe(true)
    const checkout = jobs['orcad-template-support'].steps[0]
    expect(checkout.with.ref).toBe(pinned)
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(build.steps.find((step) => step.name === 'Checkout').with.ref).toBe(pinned)
    expect(build.needs).toEqual([
      'preflight',
      'relay-windows-process-tree',
      'orcad-template-support',
      'orcad-template'
    ])
    const download = downloadStep(build)
    expect(download.uses).toBe('actions/download-artifact@v8')
    expect(download.with.path).toBe('out/orcad-template')
    expect(build.steps.indexOf(download)).toBeGreaterThan(
      build.steps.findIndex((step) => step.name === 'Build app')
    )
    expect(build.steps.indexOf(download)).toBeLessThan(build.steps.indexOf(packagingStep(build)))
    expect(jobs[`build-${channel}-win`].with.orcad_template).toBe(
      `\${{ needs.build-${channel}-mac.outputs.ships_orcad_template == 'true' }}`
    )
    expect(jobs['orcad-template'].secrets).toBeUndefined()
  })

  it.each([
    ['true', 'success', true],
    ['true', 'failure', false],
    ['true', 'cancelled', false],
    ['true', 'skipped', false],
    ['false', 'skipped', true],
    ['', 'skipped', false]
  ])('ships=%s template=%s admits packaging=%s', (ships, result, admitted) => {
    const context = { needs: needs(ships, result) }
    expect(evaluate(build.if, context)).toBe(admitted)
    expect(evaluate(downloadStep(build).if, context)).toBe(ships === 'true')
    expect(evaluate(packagingStep(build).env.ORCA_REQUIRE_ORCAD_TEMPLATE, context)).toBe(
      ships === 'true' ? '1' : ''
    )
  })

  it('blocks failed detection, failed relay, unchanged main, cancellation and forks', () => {
    for (const name of ['orcad-template-support', 'relay-windows-process-tree']) {
      const context = { needs: needs() }
      context.needs[name].result = 'failure'
      expect(evaluate(build.if, context)).toBe(false)
    }
    const unchanged = needs()
    unchanged.preflight.outputs.should_build = 'false'
    expect(evaluate(build.if, { needs: unchanged })).toBe(false)
    expect(evaluate(jobs['orcad-template-support'].if, { needs: unchanged })).toBe(false)
    expect(evaluate(build.if, { needs: needs(), cancelled: () => true })).toBe(false)
    expect(evaluate(jobs.preflight.if, { github: { repository: 'someone/fork' } })).toBe(false)
  })
})

describe('Windows standalone and reusable packaging', () => {
  const { jobs } = workflow('dev-channel-win-build')
  const build = jobs['build-win']

  it('builds the qualified template by default and preserves the signing-secret boundary', () => {
    expect(workflow('dev-channel-win-build').on.workflow_call.inputs.orcad_template.default).toBe(
      false
    )
    expect(jobs['orcad-template'].with).toEqual({ ref: '${{ inputs.ref }}', build_template: true })
    expect(jobs['orcad-template'].permissions).toEqual({ contents: 'read' })
    expect(jobs['orcad-template'].secrets).toBeUndefined()
    expect(jobs['orcad-template-support'].permissions).toEqual({ contents: 'read' })
    expect(build.environment).toBe('adhoc-mac-build')
    const download = downloadStep(build)
    expect(build.steps.indexOf(download)).toBeGreaterThan(
      build.steps.findIndex((step) => step.name === 'Build app')
    )
    expect(build.steps.indexOf(download)).toBeLessThan(build.steps.indexOf(packagingStep(build)))
  })

  it.each([
    [false, 'true', 'success', true, '1'],
    [false, 'true', 'skipped', false, '1'],
    [false, 'true', 'failure', false, '1'],
    [false, 'false', 'skipped', true, ''],
    [false, '', 'skipped', false, ''],
    [true, '', 'skipped', true, '1']
  ])(
    'caller artifact=%s ships=%s template=%s admits=%s',
    (reuse, ships, result, admitted, guard) => {
      const context = { inputs: { orcad_template: reuse }, needs: needs(ships, result) }
      if (reuse) {
        context.needs['orcad-template-support'].result = 'skipped'
      }
      expect(evaluate(build.if, context)).toBe(admitted)
      expect(evaluate(packagingStep(build).env.ORCA_REQUIRE_ORCAD_TEMPLATE, context)).toBe(guard)
      expect(evaluate(downloadStep(build).if, context)).toBe(reuse || ships === 'true')
      expect(evaluate(jobs['orcad-template-support'].if, context)).toBe(!reuse)
      expect(evaluate(build.if, { ...context, cancelled: () => true })).toBe(false)
      expect(evaluate(build.if, { ...context, github: { repository: 'someone/fork' } })).toBe(false)
    }
  )
})

it.each(['hourly-mac-build', 'daily-mac-build', 'dev-channel-win-build'])(
  '%s derives legacy-ref compatibility from the checked-out packager',
  async (name) => {
    const detector = workflow(name).jobs['orcad-template-support'].steps.find(
      (step) => step.id === 'detect'
    )
    const directory = mkdtempSync(join(tmpdir(), 'dev-template-support-'))
    const output = join(directory, 'output')
    try {
      for (const ships of [false, true]) {
        if (ships) {
          mkdirSync(join(directory, 'config/scripts'), { recursive: true })
          writeFileSync(join(directory, 'config/scripts/packaged-orcad-template.cjs'), '')
        }
        writeFileSync(output, '')
        const result = await runProcess({
          program: 'bash',
          args: ['-c', detector.run],
          cwd: directory,
          env: { ...process.env, GITHUB_OUTPUT: output }
        })
        expect(result.code, result.stderr).toBe(0)
        expect(readFileSync(output, 'utf8')).toBe(`ships=${ships}\n`)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
