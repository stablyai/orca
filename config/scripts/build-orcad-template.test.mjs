import { describe, expect, it } from 'vitest'
import { ORCAD_TEMPLATE_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { requestedTemplateTargets } from './build-orcad-template.mjs'

describe('requestedTemplateTargets', () => {
  it('builds every target unless a subset is named', () => {
    expect(requestedTemplateTargets(['node', 'build-orcad-template.mjs'])).toEqual(
      ORCAD_TEMPLATE_TARGETS
    )
  })

  it('accepts a named subset once each', () => {
    expect(
      requestedTemplateTargets([
        'node',
        'build-orcad-template.mjs',
        '--targets',
        'linux-x64-glibc,linux-x64-musl,linux-x64-glibc'
      ])
    ).toEqual(['linux-x64-glibc', 'linux-x64-musl'])
  })

  it.each([[['--targets']], [['--targets', '']], [['--targets', 'linux-x64-glibc,sunos-sparc']]])(
    'refuses %j',
    (args) => {
      expect(() => requestedTemplateTargets(['node', 'build-orcad-template.mjs', ...args])).toThrow(
        '--targets needs a comma-separated subset'
      )
    }
  )
})
