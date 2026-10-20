import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const { jobs } = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
const mac = jobs['build-adhoc-mac']
const windows = jobs['build-adhoc-win']
const publish = jobs['publish-adhoc-win']

function qualification(template = 'success', ships = 'true') {
  return {
    github: { repository: 'stablyai/orca' },
    needs: {
      'resolve-ref': { result: 'success', outputs: { sha: 'a'.repeat(40) } },
      'orcad-template-support': { result: 'success', outputs: { ships } },
      'orcad-template': { result: template }
    }
  }
}

describe('adhoc Windows compilation overlaps Mac without publishing early', () => {
  it('starts both platforms from the same qualified inputs without a Mac dependency', () => {
    expect(windows.needs).toEqual(mac.needs)
    expect(windows.needs).not.toContain('build-adhoc-mac')
    expect(windows.with.stage_only).toBe(true)
    expect(windows.with.ref).toBe('${{ needs.resolve-ref.outputs.sha }}')
    expect(windows.with.tag).toBe('v${{ needs.orcad-template-support.outputs.version }}')
    expect(windows.with.version).toBe(mac.outputs.version)
    expect(windows.with.orcad_template).toBe(
      "${{ needs.orcad-template-support.outputs.ships == 'true' }}"
    )
    const identity = jobs['orcad-template-support']
    expect(identity.outputs.version).toBe('${{ steps.adhoc.outputs.version }}')
    expect(identity.steps.filter((step) => step.id === 'adhoc')).toHaveLength(1)
    expect(mac.steps.some((step) => step.id === 'adhoc')).toBe(false)
    expect(mac.steps.find((step) => step.name === 'Create adhoc release').env.TAG).toBe(
      windows.with.tag
    )
  })

  it.each([
    ['success', 'true', true],
    ['failure', 'true', false],
    ['cancelled', 'true', false],
    ['skipped', 'true', false],
    ['skipped', 'false', true]
  ])('preserves qualification for %s / template=%s', (result, ships, allowed) => {
    const run = compileAggregateExpression(windows.if, ['needs', 'github'])
    const context = qualification(result, ships)
    expect(run(context).coerceString()).toBe(String(allowed))
    expect(run(context, true).coerceString()).toBe('false')
    context.needs['orcad-template-support'].result = 'failure'
    expect(run(context).coerceString()).toBe('false')
  })

  it.each(['success', 'failure', 'cancelled', 'skipped', ''])(
    'requires successful Mac publication and Windows compilation: %s',
    (result) => {
      const run = compileAggregateExpression(publish.if)
      const needs = {
        'build-adhoc-mac': { result: 'success', outputs: { published: 'true' } },
        'build-adhoc-win': { result: 'success' }
      }
      expect(publish.needs).toEqual(['build-adhoc-mac', 'build-adhoc-win'])
      expect(run({ needs }).coerceString()).toBe('true')
      expect(run({ needs }, true).coerceString()).toBe('false')
      for (const job of publish.needs) {
        expect(run({ needs: { ...needs, [job]: { ...needs[job], result } } }).coerceString()).toBe(
          String(result === 'success')
        )
      }
      for (const published of ['false', '', undefined]) {
        needs['build-adhoc-mac'].outputs.published = published
        expect(run({ needs }).coerceString()).toBe('false')
      }
    }
  )
})
