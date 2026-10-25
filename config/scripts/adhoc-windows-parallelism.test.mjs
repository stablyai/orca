import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const { jobs } = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
const mac = jobs['build-adhoc-mac-arch']
const final = jobs['build-adhoc-mac']
const windows = jobs['build-adhoc-win']
const publish = jobs['publish-adhoc-win']
const bundleWorkflow = parse(readFileSync('.github/workflows/release-javascript.yml', 'utf8'))

function qualification(template = 'success', ships = 'true') {
  return {
    github: { repository: 'stablyai/orca' },
    needs: {
      'resolve-ref': { result: 'success', outputs: { sha: 'a'.repeat(40) } },
      'orcad-template-support': { result: 'success', outputs: { ships } },
      'release-javascript': { result: 'success' },
      'prepare-adhoc-mac-release': { result: 'success' },
      'orcad-template': { result: template }
    }
  }
}

describe('adhoc Windows compilation overlaps Mac without publishing early', () => {
  it('starts both platforms during qualification without a Mac dependency', () => {
    expect(mac.needs).toEqual([...windows.needs, 'prepare-adhoc-mac-release'])
    expect(mac.needs).not.toContain('orcad-template')
    expect(windows.needs).not.toContain('build-adhoc-mac')
    expect(windows.with.stage_only).toBe(true)
    expect(windows.with.fast_release).toBe(true)
    expect(windows.with.ref).toBe('${{ needs.resolve-ref.outputs.sha }}')
    expect(windows.with.tag).toBe('v${{ needs.orcad-template-support.outputs.version }}')
    expect(windows.with.version).toBe(final.outputs.version)
    expect(windows.with.orcad_template).toBe(
      "${{ needs.orcad-template-support.outputs.ships == 'true' }}"
    )
    const identity = jobs['orcad-template-support']
    expect(identity.outputs.version).toBe('${{ steps.adhoc.outputs.version }}')
    expect(identity.steps.filter((step) => step.id === 'adhoc')).toHaveLength(1)
    expect(mac.steps.some((step) => step.id === 'adhoc')).toBe(false)
    expect(
      jobs['prepare-adhoc-mac-release'].steps.find((step) => step.name === 'Create adhoc release')
        .env.TAG
    ).toBe(windows.with.tag)
  })

  it('builds portable JavaScript alongside qualification and restores it on both platforms', () => {
    const bundle = jobs['release-javascript']
    expect(bundle.needs).not.toContain('orcad-template')
    expect(bundle.with.ref).toBe('${{ needs.resolve-ref.outputs.sha }}')
    expect(bundle.with.dev_build).toBe(true)
    expect(bundle.secrets).toBeUndefined()
    expect(jobs['orcad-template'].uses).toBe('./.github/workflows/qualified-orcad-template.yml')
    for (const job of [mac, windows]) {
      expect(job.needs).toContain('release-javascript')
      const evaluate = compileAggregateExpression(job.if, ['needs', 'github'])
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const ctx = qualification()
        ctx.needs['release-javascript'].result = result
        expect(evaluate(ctx).coerceString()).toBe('false')
      }
    }
    const download = mac.steps.find((step) => step.name === 'Download shared JavaScript')
    expect(download.with).toEqual({ name: 'release-javascript', path: '.build/release-javascript' })
    expect(download.if).toBe("needs.release-javascript.outputs.supported == 'true'")
    expect(mac.steps.find((step) => step.name === 'Build app').run).toContain('build:release:host')
    expect(windows.with.javascript_source_sha).toContain(
      'needs.release-javascript.outputs.source_sha'
    )
  })

  it('falls back for older refs and retains official bundle support', () => {
    const source = bundleWorkflow.jobs.bundle.steps.find((step) => step.id === 'source').run
    const script = source.split('node <<\'NODE\' >> "$GITHUB_OUTPUT"\n')[1].split('\nNODE')[0]
    const current = JSON.parse(readFileSync('package.json', 'utf8'))
    for (const [manifest, dev, expected] of [
      [current, true, true],
      [current, false, true],
      [{ scripts: {} }, true, false],
      [
        { scripts: { 'build:release:javascript': 'build', 'build:release:host': 'host' } },
        true,
        false
      ],
      [
        { scripts: { 'build:release:javascript': 'build', 'build:release:host': 'host' } },
        false,
        true
      ]
    ]) {
      const lines = []
      runInNewContext(script, {
        require: (name) => (name === 'node:fs' ? { readFileSync } : manifest),
        process: { env: { DEV_BUILD: String(dev) } },
        console: { log: (line) => lines.push(line) }
      })
      expect(lines).toEqual([`supported=${expected}`])
    }
  })

  it.each([
    ['success', 'true', true],
    ['failure', 'true', true],
    ['cancelled', 'true', true],
    ['skipped', 'true', true],
    ['skipped', 'false', true]
  ])('allows preparation before qualification ends: %s / template=%s', (result, ships, allowed) => {
    const run = compileAggregateExpression(windows.if, ['needs', 'github'])
    const context = qualification(result, ships)
    expect(run(context).coerceString()).toBe(String(allowed))
    expect(run(context, true).coerceString()).toBe('false')
    context.needs['orcad-template-support'].result = 'failure'
    expect(run(context).coerceString()).toBe('false')
  })

  it.each(['success', 'failure', 'cancelled', 'skipped', ''])(
    'publishes only after both Windows compilation and macOS publication succeed: %s',
    (result) => {
      const run = compileAggregateExpression(publish.if)
      const needs = {
        'orcad-template-support': { result: 'success' },
        'build-adhoc-win': { result: 'success' },
        'build-adhoc-mac': { result: 'success' }
      }
      expect(publish.needs).toEqual([
        'orcad-template-support',
        'build-adhoc-win',
        'build-adhoc-mac'
      ])
      expect(publish.with.wait_for_mac_job).toBeUndefined()
      expect(run({ needs }).coerceString()).toBe('true')
      expect(run({ needs }, true).coerceString()).toBe('false')
      for (const job of publish.needs) {
        expect(run({ needs: { ...needs, [job]: { ...needs[job], result } } }).coerceString()).toBe(
          String(result === 'success')
        )
      }
    }
  )
})
