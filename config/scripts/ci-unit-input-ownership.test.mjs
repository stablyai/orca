import { describe, expect, it } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'
import { checkUnitInputOwnership, unitInputSourceDigest } from './ci-unit-input-ownership.mjs'

const owner = 'src/census.test.ts'
const helper = 'src/census-reader.ts'
const options = 'src/census-options.ts'
const original = new Map([
  [owner, "import { census } from './census-reader'; census()"],
  [
    helper,
    "import { options } from './census-options'; export const census = () => ts.createProgram(options)"
  ],
  [options, 'export const options = {}'],
  ['src/domain/value.ts', 'export const value = 1'],
  ['src/domain/value.test.ts', "import './value'"],
  ['src/other.ts', 'export const other = 1'],
  ['src/other.test.ts', "import './other'"]
])
const record = {
  file: helper,
  inputs: ['src/domain/'],
  emptyEnv: [],
  contextSha256: buildUnitDependencyGraph(original).ownershipContextSha256,
  sourceClosureSha256: unitInputSourceDigest(
    new Map([
      [helper, original.get(helper)],
      [options, original.get(options)]
    ])
  ),
  reason: 'This fixture compiler reads only the domain source directory.'
}

function graph(sources = original, records = [record]) {
  return {
    ...buildUnitDependencyGraph(sources, undefined, records),
    files: new Set(sources.keys())
  }
}

function selection(changed, input = graph()) {
  const tests = [...input.files].filter((file) => file.endsWith('.test.ts'))
  return selectUnitFiles(tests, changed, input)
}

describe('checked indirect unit inputs', () => {
  it('retains a declared consumer while excluding it for unrelated source changes', () => {
    expect(selection(['src/domain/value.ts']).files).toEqual([owner, 'src/domain/value.test.ts'])
    expect(selection(['src/other.ts']).files).toEqual(['src/other.test.ts'])
    expect(graph().opaque.has(helper)).toBe(false)
  })

  it('owns new files under a directory even with a direct consumer hiding full fallback', () => {
    const sources = new Map(original)
    sources.set('src/domain/added.ts', 'export const added = 1')
    sources.set('src/domain/added.test.ts', "import './added'")
    expect(selection(['src/domain/added.ts'], graph(sources))).toMatchObject({
      full: false,
      files: [owner, 'src/domain/added.test.ts']
    })
  })

  it('bounds an entry point without suppressing other callers of its indirect reader', () => {
    const sources = new Map(original)
    const otherCaller = 'src/other-census.test.ts'
    sources.set(otherCaller, "import { census } from './census-reader'; census()")
    const entry = {
      ...record,
      file: owner,
      sourceClosureSha256: unitInputSourceDigest(
        new Map([owner, helper, options].map((file) => [file, sources.get(file)]))
      )
    }
    const input = graph(sources, [entry])
    expect(selection(['src/other.ts'], input).files).toEqual(['src/other.test.ts', otherCaller])
    expect(selection(['src/domain/value.ts'], input).files).toContain(owner)
    expect(selection([helper], input).files).toContain(owner)
    expect(selection([owner], input).files).toContain(owner)
    expect(input.opaque.has(helper)).toBe(true)
  })

  it('invalidates declarations after dependency or shared-runtime changes', () => {
    const dependencyInputs = new Map([['pnpm-lock.yaml', 'reviewed dependencies']])
    const contextSha256 = buildUnitDependencyGraph(
      original,
      undefined,
      [],
      dependencyInputs
    ).ownershipContextSha256
    const records = [{ ...record, contextSha256 }]
    expect(
      buildUnitDependencyGraph(original, undefined, records, dependencyInputs).opaque.has(helper)
    ).toBe(false)
    dependencyInputs.set('pnpm-lock.yaml', 'updated dependencies')
    expect(
      buildUnitDependencyGraph(original, undefined, records, dependencyInputs).opaque.has(helper)
    ).toBe(true)
    const sources = new Map(original)
    sources.set('config/scripts/vitest-dom-setup.ts', 'configureDifferentRuntime()')
    expect(graph(sources).opaque.has(helper)).toBe(true)
  })

  it('keeps deleted and renamed inputs on the full fallback', () => {
    const sources = new Map(original)
    sources.delete('src/domain/value.ts')
    sources.set('src/domain/renamed.ts', 'export const value = 1')
    expect(selection(['src/domain/value.ts'], graph(sources)).full).toBe(true)
    expect(selection(['src/domain/value.ts', 'src/domain/renamed.ts'], graph(sources)).full).toBe(
      true
    )
  })

  it.each(
    [
      [],
      [{ ...record, sourceClosureSha256: '0'.repeat(64) }],
      [record, { ...record, reason: '' }],
      [{ ...record, inputs: ['src/domain/../other.ts'] }],
      [{ ...record, inputs: ['src/domain\\value.ts'] }],
      [{ ...record, inputs: ['src/domain/**'] }]
    ].map((records) => ({ records }))
  )('retains unowned or invalidly owned consumers: %j', ({ records }) => {
    expect(selection(['src/other.ts'], graph(original, records)).files).toContain(owner)
    expect(graph(original, records).opaque.has(helper)).toBe(true)
  })

  it('invalidates ownership when a statically imported helper changes', () => {
    const sources = new Map(original)
    sources.set(options, 'export const options = { rootDir: "src/other" }')
    const result = graph(sources)
    expect(result.opaque.has(helper)).toBe(true)
    expect(selection(['src/other.ts'], result).files).toContain(owner)
  })

  it('rejects a closure changed by a newly resolved JavaScript sibling', () => {
    const sources = new Map(original)
    sources.set('src/census-options.js', 'export const options = { rootDir: "src/other" }')
    expect(graph(sources).opaque.has(helper)).toBe(true)
    expect(selection(['src/other.ts'], graph(sources)).files).toContain(owner)
  })

  it('does not clear unresolved local-import fallback with a matching known-source digest', () => {
    const sources = new Map(original)
    sources.set(
      helper,
      "import { options } from './census-options'; import './missing'; export const census = () => ts.createProgram(options)"
    )
    const matching = {
      ...record,
      sourceClosureSha256: unitInputSourceDigest(
        new Map([
          [helper, sources.get(helper)],
          [options, sources.get(options)]
        ])
      )
    }
    expect(graph(sources, [matching]).opaque.has(helper)).toBe(true)
  })

  it('rejects environment-dependent declarations when the required variable is set', () => {
    const conditional = { ...record, emptyEnv: ['ORCA_CENSUS_EXTRA_ROOT'] }
    const closure = () =>
      new Map([
        [helper, original.get(helper)],
        [options, original.get(options)]
      ])
    expect(
      checkUnitInputOwnership([conditional], closure, {}, record.contextSha256).has(helper)
    ).toBe(true)
    expect(
      checkUnitInputOwnership(
        [conditional],
        closure,
        { ORCA_CENSUS_EXTRA_ROOT: 'src/other/' },
        record.contextSha256
      ).size
    ).toBe(0)
  })
})
