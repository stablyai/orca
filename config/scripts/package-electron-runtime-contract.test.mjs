import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')

describe('Electron runtime package contract', () => {
  it('qualifies macOS after failed sibling builds and publishes only complete successful builds', () => {
    const { jobs } = parse(readProject('.github/workflows/release-cut.yml'))
    const evaluate = (source, needs, cancelled) =>
      runInNewContext(source.replace(/needs\.([a-z][a-z0-9-]*)/g, 'needs["$1"]'), {
        needs,
        cancelled: () => cancelled,
        contains: (value, part) => value.includes(part)
      })
    const results = ['success', 'failure', 'skipped', 'cancelled']
    for (const matrix of results) {
      for (const dispatch of results) {
        for (const verification of results) {
          for (const cancelled of [false, true]) {
            const needs = {
              cut: { result: 'success', outputs: { should_release: 'true', tag: 'v1.5.0' } },
              build: { result: matrix },
              'build-mac': { result: dispatch },
              'verify-mac-build': { result: verification },
              'skill-sharing-linux-floor-release-gate': { result: 'success' },
              'skill-sharing-release-gate': { result: 'success' },
              'terminal-rendering-golden': { result: 'success' }
            }
            expect(evaluate(jobs['verify-mac-build'].if, needs, cancelled)).toBe(
              !cancelled && dispatch === 'success'
            )
            expect(evaluate(jobs['publish-release'].if, needs, cancelled)).toBe(
              !cancelled &&
                matrix === 'success' &&
                dispatch === 'success' &&
                verification === 'success'
            )
          }
        }
      }
    }
    for (const prerequisite of [
      'cut',
      'skill-sharing-linux-floor-release-gate',
      'skill-sharing-release-gate',
      'terminal-rendering-golden'
    ]) {
      const needs = Object.fromEntries([
        ['cut', { result: 'success', outputs: { should_release: 'true', tag: 'v1.5.0' } }],
        ...[
          'build',
          'build-mac',
          'verify-mac-build',
          'skill-sharing-linux-floor-release-gate',
          'skill-sharing-release-gate',
          'terminal-rendering-golden'
        ].map((name) => [name, { result: 'success' }])
      ])
      needs[prerequisite].result = 'failure'
      expect(evaluate(jobs['publish-release'].if, needs, false)).toBe(false)
    }
  })
})
