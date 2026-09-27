import { describe, expect, it } from 'vitest'
import {
  isIgnoredNestedRepoDirectory,
  readNestedRepoGitignoreRules,
  readNestedRepoGlobMatchSteps
} from './nested-repo-scan-rules'

async function readRules(content: string) {
  return readNestedRepoGitignoreRules({
    folderPath: '/synthetic',
    entries: [{ name: '.gitignore', isDirectory: false }],
    baseSegments: [],
    filesystem: {
      readDirectory: async () => [],
      readTextFile: async () => content,
      joinPath: (parent, child) => `${parent}/${child}`,
      basename: (path) => path,
      hasGitMarker: () => false,
      isSelectedPathGitRepo: () => false
    }
  })
}

function strings(alphabet: string[], maxLength: number): string[] {
  const result = ['']
  let layer = ['']
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap((prefix) => alphabet.map((character) => prefix + character))
    result.push(...layer)
  }
  return result
}

function segmentLists(alphabet: string[], maxLength: number): string[][] {
  const result: string[][] = []
  let layer: string[][] = [[]]
  for (let length = 1; length <= maxLength; length++) {
    layer = layer.flatMap((prefix) => alphabet.map((token) => [...prefix, token]))
    result.push(...layer)
  }
  return result
}

// Pre-change oracle: a regular expression per wildcard segment, plus an unmemoized `**` walk over
// uncollapsed segments. Differential cases hold the shipped matcher to exactly this behaviour.
function referenceSegment(pattern: string): string | RegExp {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
}

function referenceSegmentMatches(pattern: string | RegExp, value: string): boolean {
  return typeof pattern === 'string' ? pattern === value : pattern.test(value)
}

function referenceIgnored(line: string, candidateSegments: string[]): boolean {
  const anchored = line.startsWith('/')
  const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!anchored && !pattern.includes('/')) {
    const segment = referenceSegment(pattern)
    return candidateSegments.some((candidate) => referenceSegmentMatches(segment, candidate))
  }
  const patternSegments = pattern
    .split('/')
    .map((segment) => (segment === '**' ? segment : referenceSegment(segment)))
  const matchFrom = (patternIndex: number, candidateIndex: number): boolean => {
    if (patternIndex >= patternSegments.length) {
      return candidateIndex >= candidateSegments.length
    }
    const segment = patternSegments[patternIndex]
    if (segment === '**') {
      return (
        matchFrom(patternIndex + 1, candidateIndex) ||
        (candidateIndex < candidateSegments.length && matchFrom(patternIndex, candidateIndex + 1))
      )
    }
    return (
      candidateIndex < candidateSegments.length &&
      referenceSegmentMatches(segment, candidateSegments[candidateIndex] ?? '') &&
      matchFrom(patternIndex + 1, candidateIndex + 1)
    )
  }
  return matchFrom(0, 0)
}

function stepsSpentOn(run: () => void): number {
  const before = readNestedRepoGlobMatchSteps()
  run()
  return readNestedRepoGlobMatchSteps() - before
}

describe('nested repository wildcard work budget', () => {
  it('bounds wildcard segment work for fifty adverse names', async () => {
    const rules = await readRules(`${'*a'.repeat(12)}b`)
    const name = `${'a'.repeat(24)}c`
    let ignored = 0
    const steps = stepsSpentOn(() => {
      for (let index = 0; index < 50; index++) {
        ignored += Number(isIgnoredNestedRepoDirectory(name, [name], rules))
      }
    })
    expect(ignored).toBe(0)
    // O(pattern length x name length) per name, ~51 steps in practice; the pre-change expression
    // revisited earlier stars and needed ~25 ms for each of these names.
    expect(steps).toBeLessThan(50 * 100)
  })

  it('bounds ** path work for a long run of double stars', async () => {
    const rules = await readRules(`${'**/'.repeat(24)}z`)
    const candidate = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    let ignored = true
    // Parse-time collapse of the `**` run; uncollapsed this shape cost ~49M recursive calls.
    const steps = stepsSpentOn(() => {
      ignored = isIgnoredNestedRepoDirectory('h', candidate, rules)
    })
    expect(ignored).toBe(false)
    expect(steps).toBeLessThan(100)
  })

  it('bounds ** path work when non-collapsible segments separate the double stars', async () => {
    const rules = await readRules(Array.from({ length: 12 }, () => '**/*').join('/'))
    const candidate = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    let ignored = true
    // Memoization; without it this shape revisits pairs and costs over a thousand calls.
    const steps = stepsSpentOn(() => {
      ignored = isIgnoredNestedRepoDirectory('h', candidate, rules)
    })
    expect(ignored).toBe(false)
    expect(steps).toBeLessThan(400)
  })

  it('accepts exactly the same paths for a collapsed and an expanded ** run', async () => {
    const collapsed = await readRules('**/x')
    const expanded = await readRules('**/**/**/x')
    for (const candidate of segmentLists(['a', 'x'], 4)) {
      const name = candidate.at(-1) ?? ''
      const label = candidate.join('/')
      const expectedMatch = referenceIgnored('**/x', candidate)
      expect(isIgnoredNestedRepoDirectory(name, candidate, collapsed), label).toBe(expectedMatch)
      expect(isIgnoredNestedRepoDirectory(name, candidate, expanded), label).toBe(expectedMatch)
      expect(referenceIgnored('**/**/**/x', candidate), label).toBe(expectedMatch)
    }
  })

  it('preserves wildcard results for every short pattern and name', async () => {
    const names = strings(['a', 'b', '?'], 4)
    for (const pattern of strings(['a', 'b', '*', '?'], 4).slice(1)) {
      const rules = await readRules(pattern)
      for (const name of names) {
        expect(isIgnoredNestedRepoDirectory(name, [name], rules), `${pattern} / ${name}`).toBe(
          referenceIgnored(pattern, [name])
        )
      }
    }
  })

  it('preserves path results for every short multi-segment pattern and candidate path', async () => {
    const candidates = segmentLists(['a', 'b', 'ab'], 3)
    for (const patternSegments of segmentLists(['a', 'b', '*', '?', '**'], 3)) {
      const joined = patternSegments.join('/')
      // The leading slash anchors the rule, which is the non-basenameOnly path even at one segment.
      for (const line of [joined, `/${joined}`]) {
        const rules = await readRules(line)
        for (const candidate of candidates) {
          expect(
            isIgnoredNestedRepoDirectory(candidate.at(-1) ?? '', candidate, rules),
            `${line} / ${candidate.join('/')}`
          ).toBe(referenceIgnored(line, candidate))
        }
      }
    }
  })

  it.each([
    ['[literal]+.*', '[literal]+.suffix', true],
    ['[literal]+.*', 'literal-suffix', false],
    ['a\\*', 'a\\suffix', true],
    ['*', 'a/b', false],
    ['a?', 'a\n', true],
    ['a?b', 'a\nb', true],
    ['a*b', 'ab\n', false],
    ['?', '😀', false],
    ['??', '😀', true],
    ['*😀?', 'x😀a', true],
    ['*?*a*', 'ba', true],
    ['**b**', 'abca', true]
  ])('preserves literal and code-unit matching for %s / %s', async (pattern, name, expected) => {
    const rules = await readRules(pattern)
    expect(isIgnoredNestedRepoDirectory(name, [name], rules)).toBe(expected)
  })
})
