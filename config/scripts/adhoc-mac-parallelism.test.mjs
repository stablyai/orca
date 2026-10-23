import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const { jobs } = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
const build = jobs['build-adhoc-mac-arch']
const final = jobs['build-adhoc-mac']

describe('parallel Mac release publication', () => {
  it('uses isolated architecture workspaces with one shared draft and one publisher', () => {
    expect(build.strategy).toEqual({ 'fail-fast': false, matrix: { arch: ['x64', 'arm64'] } })
    expect(build.needs).toContain('prepare-adhoc-mac-release')
    expect(final.needs).toContain('build-adhoc-mac-arch')
    expect(build.steps.some((step) => step.run?.includes('gh release create'))).toBe(false)
    expect(build.steps.some((step) => step.run?.includes('--draft=false'))).toBe(false)
    const upload = build.steps.find(
      (step) => step.name === 'Upload verified architecture assets to the draft'
    )
    expect(upload.env.TAG).toBe('${{ needs.prepare-adhoc-mac-release.outputs.tag }}')
    expect(upload.run).not.toContain('latest-mac.yml')
    expect(build.steps.find((step) => step.name === 'Verify signed and stapled app').run).toContain(
      'codesign --verify --deep --strict'
    )
    expect(build.steps.find((step) => step.name === 'Verify signed and stapled app').run).toContain(
      'xcrun stapler validate'
    )
  })

  it.each(['failure', 'cancelled', 'skipped', 'success'])(
    'runs the final gate and cleanup after architecture result %s',
    (result) => {
      const needs = {
        'prepare-adhoc-mac-release': { result: 'success' },
        'build-adhoc-mac-arch': { result }
      }
      expect(final.if).toContain('always()')
      expect(
        compileAggregateExpression(final.if.replace('always()', 'true'))({ needs }).coerceString()
      ).toBe('true')
      const gate = final.steps.findIndex((step) => step.name === 'Require both architecture jobs')
      const merge = final.steps.findIndex(
        (step) => step.name === 'Merge and verify the updater manifest'
      )
      const publish = final.steps.findIndex((step) => step.id === 'publish_live')
      expect(final.steps[gate].env.ARCH_RESULT).toBe('${{ needs.build-adhoc-mac-arch.result }}')
      expect(final.steps[gate].run).toBe('test "$ARCH_RESULT" = success')
      expect(gate).toBeLessThan(merge)
      expect(merge).toBeLessThan(publish)
      const cleanup = final.steps.find(
        (step) => step.name === 'Discard the draft release on failure'
      )
      expect(cleanup.if).toContain('failure() || cancelled()')
      expect(cleanup.if).toContain("steps.publish_live.outcome != 'success'")
    }
  )
})
