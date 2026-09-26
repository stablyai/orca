import { cpuUsage } from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  isIgnoredNestedRepoDirectory,
  readNestedRepoGitignoreRules
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

describe('nested repository wildcard work budget', () => {
  it('rejects fifty short adverse names within half a second of CPU work', async () => {
    const rules = await readRules(`${'*a'.repeat(12)}b`)
    const name = `${'a'.repeat(24)}c`
    const started = cpuUsage()
    let ignored = 0
    for (let index = 0; index < 50; index++) {
      ignored += Number(isIgnoredNestedRepoDirectory(name, [name], rules))
    }
    const elapsed = cpuUsage(started)
    expect(ignored).toBe(0)
    expect(elapsed.user + elapsed.system).toBeLessThan(500_000)
  })

  it('preserves wildcard results for every short pattern and name', async () => {
    const names = strings(['a', 'b', '?'], 4)
    for (const pattern of strings(['a', 'b', '*', '?'], 4).slice(1)) {
      const rules = await readRules(pattern)
      const expression = new RegExp(`^${pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
      for (const name of names) {
        const expected =
          pattern.includes('*') || pattern.includes('?') ? expression.test(name) : pattern === name
        expect(isIgnoredNestedRepoDirectory(name, [name], rules), `${pattern} / ${name}`).toBe(
          expected
        )
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
