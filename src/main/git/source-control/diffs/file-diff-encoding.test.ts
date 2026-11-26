import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type {
  GitDiffEncoding,
  GitDiffResult
} from '../../../../shared/git/diff/git-diff-compare-types'
import { getBranchDiff } from '../comparisons/branch-diff'
import { getCommitDiff } from '../comparisons/commit-diff'
import { getDiff } from './file-diff'

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'orca-git-diff-encoding-'))
  onTestFinished(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  return { repo, git }
}

it('keeps the chosen text encoding across Git sources and concurrent UTF-8 reads', async () => {
  const { repo, git } = createRepo()
  git('config', 'user.name', 'Orca Test')
  git('config', 'user.email', 'orca@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  const filePath = 'sample.c'
  const writeBytes = (hex: string) => writeFileSync(join(repo, filePath), Buffer.from(hex, 'hex'))
  writeBytes('b2e2cad4')
  git('add', filePath)
  git('commit', '-qm', 'initial')
  const parentOid = git('rev-parse', 'HEAD')
  writeBytes('d6d0cec4')
  git('commit', '-qam', 'update')
  const commitOid = git('rev-parse', 'HEAD')
  writeBytes('d6d0cec4b8c4')
  git('add', filePath)
  writeBytes('d6d0cec495328236')

  async function check(
    read: (encoding?: GitDiffEncoding) => Promise<GitDiffResult>,
    originalContent: string,
    modifiedContent: string
  ): Promise<void> {
    const [utf8, gb18030] = await Promise.all([read(), read('gb18030')])
    expect(utf8.originalContent).toContain('�')
    expect(gb18030).toMatchObject({
      kind: 'text',
      encoding: 'gb18030',
      originalContent,
      modifiedContent
    })
  }

  await check((encoding) => getDiff(repo, filePath, false, false, { encoding }), '中文改', '中文𠀀')
  await check((encoding) => getDiff(repo, filePath, true, false, { encoding }), '中文', '中文改')
  await check((encoding) => getDiff(repo, filePath, false, true, { encoding }), '中文', '中文𠀀')
  await check(
    (encoding) =>
      getBranchDiff(repo, { headOid: commitOid, mergeBase: parentOid, filePath }, { encoding }),
    '测试',
    '中文'
  )
  await check(
    (encoding) => getCommitDiff(repo, { commitOid, parentOid, filePath }, { encoding }),
    '测试',
    '中文'
  )
})

it('preserves UTF-8 produced by Git or a textconv driver for a GB18030 source', async () => {
  const { repo, git } = createRepo()
  writeFileSync(
    join(repo, '.gitattributes'),
    'normalized.c working-tree-encoding=GB18030\nconverted.c diff=legacy\n'
  )
  writeFileSync(
    join(repo, 'to-utf8.cjs'),
    "process.stdout.write(new TextDecoder('gb18030').decode(require('node:fs').readFileSync(process.argv[2])))"
  )
  git('config', 'diff.legacy.textconv', 'node to-utf8.cjs')
  writeFileSync(join(repo, 'normalized.c'), Buffer.from('d6d0cec4', 'hex'))
  writeFileSync(join(repo, 'converted.c'), Buffer.from('d6d0cec495328236', 'hex'))
  git('add', 'normalized.c', 'converted.c')
  writeFileSync(join(repo, 'normalized.c'), Buffer.from('d6d0cec495328236', 'hex'))

  const options = { encoding: 'gb18030' } as const
  expect(await getDiff(repo, 'normalized.c', false, false, options)).toMatchObject({
    originalContent: '中文',
    modifiedContent: '中文𠀀'
  })
  expect(await getDiff(repo, 'converted.c', true, false, options)).toMatchObject({
    originalContent: '',
    modifiedContent: '中文𠀀'
  })
})
