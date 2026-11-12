import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  collectBaseLineBlocks,
  collectAddedLineRanges,
  isUnloadedPluginDirectiveUnusedWarning
} from './check-changed-code-quality.mjs'

describe('changed-code quality line matching', () => {
  it.each(['edit', 'rename'])('treats bracketed filenames literally after %s', (change) => {
    const repo = mkdtempSync(path.join(tmpdir(), 'changed-code-quality-literal-'))
    try {
      const hooks = `core.hooksPath=${path.join(repo, '.git', 'no-hooks')}`
      const git = (...args) => {
        const result = runProcessSync({
          program: 'git',
          args: ['-c', 'commit.gpgsign=false', '-c', hooks, ...args],
          cwd: repo
        })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git('init', '--quiet')
      const file = '[cd].ts'
      const source = change === 'rename' ? '[ab].ts' : file
      const content = 'export const first = 1\n\nexport const legacy = 3\n'
      writeFileSync(path.join(repo, source), content)
      writeFileSync(path.join(repo, 'c.ts'), content)
      git('add', '.')
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      if (change === 'rename') {
        git('mv', source, file)
      }
      writeFileSync(path.join(repo, file), content.replace('first = 1', 'first = 2'))
      writeFileSync(path.join(repo, 'c.ts'), content.replace('legacy = 3', 'legacy = 4'))

      const { rangesByFile } = collectAddedLineRanges(repo, base)
      expect(rangesByFile.get(file)).toEqual([{ start: 1, end: 1 }])
      expect(rangesByFile.get('c.ts')).toEqual([{ start: 3, end: 3 }])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('moved-code exemption', () => {
  it('reads the base text of a file that was renamed away', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'changed-code-quality-rename-'))
    try {
      const git = (...args) => {
        const result = runProcessSync({
          program: 'git',
          args: ['-c', 'commit.gpgsign=false', ...args],
          cwd: repo
        })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git('init', '--quiet')
      writeFileSync(path.join(repo, 'old.ts'), 'const moved = value as Thing\n')
      git('add', 'old.ts')
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      git('mv', 'old.ts', 'new.ts')

      expect(collectBaseLineBlocks(repo, base)).toEqual([['const moved = value as Thing']])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('reads filenames containing newlines', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'changed-code-quality-newline-'))
    try {
      const git = (...args) => {
        const result = runProcessSync({ program: 'git', args, cwd: repo })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git('init', '--quiet')
      const file = 'line\nbreak.ts'
      writeFileSync(path.join(repo, file), 'const kept = true\n')
      git('add', '--all')
      git(
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '-qm',
        'base'
      )
      expect(collectBaseLineBlocks(repo, git('rev-parse', 'HEAD'), [file])).toEqual([
        ['const kept = true']
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('secondary-scan directive exemption', () => {
  it('exempts type-aware and import-plugin directives from the root scan alone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'changed-code-quality-type-aware-'))
    try {
      writeFileSync(
        path.join(root, 'a.ts'),
        [
          '// oxlint-disable-next-line typescript/return-await -- catch must not cover this',
          '// oxlint-disable-next-line typescript/return-await-extra -- unknown rule',
          '// oxlint-disable-next-line no-console -- root rule',
          '// oxlint-disable-next-line import/no-cycle -- singleton hub'
        ].join('\n')
      )
      const unused = (line) => ({
        message: 'Unused oxlint-disable directive (no problems were reported).',
        filename: 'a.ts',
        labels: [{ span: { line } }]
      })
      const exempt = (line, scan) =>
        isUnloadedPluginDirectiveUnusedWarning(unused(line), root, scan)
      expect(exempt(1, 'code quality')).toBe(true)
      expect(exempt(1, 'type-aware code quality')).toBe(false)
      expect(exempt(2, 'code quality')).toBe(false)
      expect(exempt(3, 'code quality')).toBe(false)
      expect(exempt(4, 'code quality')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
