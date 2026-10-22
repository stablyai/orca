import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'sort-comparator-performance',
    pluginPath: path.resolve('config/oxlint-plugins/sort-comparator-performance.mjs'),
    rules: { 'sort-comparator-performance/no-repeated-collator': 'warn' },
    sources
  })
}

const sources = {
  repeatedCollation: `
      rows.sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }))
      rows.toSorted(function (a, b) { return new Intl.Collator('sv').compare(a, b) })
      rows['sort']((a, b) => Intl.Collator('en', { numeric: true }).compare(a, b))
      rows.sort((a, b) => a['localeCompare'](b, undefined, options))
    `,
  acceptedComparisons: `
      const collator = new Intl.Collator(locale, options)
      rows.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
      rows.toSorted(collator.compare)
      const equal = a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
      rows.map(a => new Intl.Collator(a.locale))
      rows.sort((a, b) => {
        function deferred() { return new Intl.Collator(locale) }
        return a - b
      })
    `
}

const diagnosticsBySource = new Map()
beforeAll(() => {
  const fixtures = Object.values(sources)
  lintSources(fixtures).forEach((diagnostics, index) => {
    diagnosticsBySource.set(fixtures[index], diagnostics)
  })
})

describe('sort comparator performance', () => {
  it('reports repeated collation setup in inline sort and toSorted callbacks', () => {
    const findings = diagnosticsBySource.get(sources.repeatedCollation)
    expect(findings).toHaveLength(4)
    expect(
      findings.every(
        (finding) => finding.code === 'sort-comparator-performance(no-repeated-collator)'
      )
    ).toBe(true)
  })

  it('allows one collator per sort, bare comparisons, and unrelated callbacks', () => {
    expect(diagnosticsBySource.get(sources.acceptedComparisons)).toEqual([])
  })
})
