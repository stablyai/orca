import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { matchesVitestFileFilters, vitestCliFileFilters } from './vitest-file-filters.mjs'

const cli = ['node', resolve('node_modules/vitest/vitest.mjs')]

it('uses Vitest parsing to separate test paths from revision and name options', () => {
  expect(
    vitestCliFileFilters([
      ...cli,
      'run',
      'src/value.test.ts:42',
      '--changed=HEAD',
      '-t',
      'some name'
    ])
  ).toEqual(['src/value.test.ts'])
  expect(vitestCliFileFilters([...cli, 'related', '--run', 'src/value.ts'])).toEqual([])
  expect(vitestCliFileFilters([...cli, 'watch', 'src/value.test.ts'])).toEqual([])
  expect(vitestCliFileFilters([...cli, 'run', '--watch', 'src/value.test.ts'])).toEqual([])
  expect(vitestCliFileFilters(['node', 'programmatic.mjs', 'src/value.test.ts'])).toEqual([])
})

it('retains substring, directory, absolute and case-insensitive file matches', () => {
  const root = process.cwd()
  for (const filter of ['VALUE', './src/', 'value.test.ts', resolve('src/value.test.ts')]) {
    expect(matchesVitestFileFilters('src/value.test.ts', [filter], root)).toBe(true)
  }
  expect(matchesVitestFileFilters('src/other.test.ts', ['value'], root)).toBe(false)
  expect(matchesVitestFileFilters('src/other.test.ts', [], root)).toBe(true)
})
