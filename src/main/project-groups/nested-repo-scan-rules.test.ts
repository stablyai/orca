import { describe, expect, it } from 'vitest'
import {
  getNestedRepoDirectoryExclusion,
  isIgnoredNestedRepoDirectory,
  readNestedRepoGitignoreRules
} from './nested-repo-scan-rules'

async function readRules(content: string, baseSegments: string[] = []) {
  return readNestedRepoGitignoreRules({
    folderPath: '/workspace',
    entries: [{ name: '.gitignore', isDirectory: false }],
    baseSegments,
    filesystem: {
      readDirectory: async () => [],
      readTextFile: async () => content,
      joinPath: (parent, child) => `${parent}/${child}`,
      basename: (path) => path.split('/').at(-1) ?? '',
      hasGitMarker: () => false,
      isSelectedPathGitRepo: () => false
    }
  })
}

describe('nested repository ignore rules', () => {
  it('reports only the effective positive rule with its original line and scope', async () => {
    const rules = await readRules('# ignored comment\ncache*\n!cache-keep\n/cache-other/', [
      'parent'
    ])
    expect(
      getNestedRepoDirectoryExclusion('cache-keep', ['parent', 'cache-keep'], rules)
    ).toBeNull()
    expect(
      getNestedRepoDirectoryExclusion('cache-other', ['parent', 'cache-other'], rules)
    ).toEqual({
      reason: 'gitignore',
      ignoreFile: '/workspace/.gitignore',
      rule: '/cache-other/',
      line: 4
    })
    expect(
      getNestedRepoDirectoryExclusion(
        'node_modules',
        ['parent', 'node_modules'],
        await readRules('*\n!*')
      )
    ).toEqual({ reason: 'builtin' })
    expect(getNestedRepoDirectoryExclusion('.hidden', ['parent', '.hidden'], [])).toEqual({
      reason: 'hidden'
    })
  })

  it.each([
    ['cache*', ['parent', 'cache-data', 'child'], true],
    ['cache*\n!cache-keep', ['parent', 'cache-keep'], false],
    ['/cache*', ['parent', 'cache-data'], false],
    ['/cache*', ['cache-data'], true],
    ['packages/*/output?', ['packages', 'app', 'output1'], true],
    ['packages/*/output?', ['packages', 'app', 'nested', 'output1'], false],
    ['packages/**/output?', ['packages', 'output1'], true],
    ['packages/**/output?', ['packages', 'app', 'nested', 'output1'], true],
    ['**', ['anything', 'child'], true],
    ['/**', ['anything', 'child'], true],
    ['**\n!**', ['anything', 'child'], false],
    ['[literal]+.*', ['[literal]+.suffix'], true],
    ['[literal]+.*', ['literal-suffix'], false]
  ])('matches %s against %j', async (content, segments, expected) => {
    const rules = await readRules(content)
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(isIgnoredNestedRepoDirectory(segments.at(-1)!, segments, rules)).toBe(expected)
    }
  })

  it('scopes inherited anchored patterns to the directory that declared them', async () => {
    const rules = await readRules('/cache*', ['parent'])
    expect(isIgnoredNestedRepoDirectory('cache-data', ['parent', 'cache-data'], rules)).toBe(true)
    expect(
      isIgnoredNestedRepoDirectory('cache-data', ['parent', 'child', 'cache-data'], rules)
    ).toBe(false)
    expect(isIgnoredNestedRepoDirectory('parent', ['parent'], rules)).toBe(false)
  })
})
