import { execFileSync, spawnSync } from 'node:child_process'
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

it.each([
  {
    edit: 'normalizes CRLF',
    attributes: '-text',
    hex: 'c2a90d0a',
    rewrite: "input.replaceAll('\\r\\n', '\\n')",
    utf8: '©\n',
    gb18030: '漏\n'
  },
  {
    edit: 'appends ASCII to a GB18030 checkout of a normalized blob',
    attributes: 'working-tree-encoding=GB18030',
    hex: 'c2a9',
    rewrite: "input + '!'",
    utf8: '©!',
    gb18030: '漏!'
  }
])(
  'honors the selected encoding when textconv $edit',
  async ({ attributes, hex, rewrite, utf8, gb18030 }) => {
    const { repo, git } = createRepo()
    writeFileSync(join(repo, '.gitattributes'), `sample.c ${attributes} diff=legacy\n`)
    writeFileSync(
      join(repo, 'edit.cjs'),
      [
        "const input = require('node:fs').readFileSync(process.argv[2], 'latin1')",
        `process.stdout.write(${rewrite}, 'latin1')`
      ].join('\n')
    )
    git('config', 'diff.legacy.textconv', 'node edit.cjs')
    writeFileSync(join(repo, 'sample.c'), Buffer.from(hex, 'hex'))
    git('add', 'sample.c')

    const read = (encoding: GitDiffEncoding) => getDiff(repo, 'sample.c', true, false, { encoding })
    expect((await read('utf-8')).modifiedContent).toBe(utf8)
    expect((await read('gb18030')).modifiedContent).toBe(gb18030)
  }
)

it.each([
  { attributes: '-text', bytes: 'c4e3bac30d0a953282360a', expected: '你好\n𠀀\n' },
  { attributes: '-text working-tree-encoding=GB18030', bytes: 'c4e3bac30d0a', expected: '你好\n' }
])(
  'recognizes a transcode with CRLF normalization ($attributes)',
  async ({ attributes, bytes, expected }) => {
    const { repo, git } = createRepo()
    writeFileSync(join(repo, '.gitattributes'), `sample.c ${attributes} diff=legacy\n`)
    writeFileSync(
      join(repo, 'convert.cjs'),
      [
        "const bytes = require('node:fs').readFileSync(process.argv[2])",
        "const text = new TextDecoder('gb18030').decode(bytes)",
        "process.stdout.write(text.replaceAll('\\r\\n', '\\n'), 'utf8')"
      ].join('\n')
    )
    git('config', 'diff.legacy.textconv', 'node convert.cjs')
    writeFileSync(join(repo, 'sample.c'), Buffer.from(bytes, 'hex'))
    git('add', 'sample.c')

    const diff = await getDiff(repo, 'sample.c', true, false, { encoding: 'gb18030' })
    expect(diff.modifiedContent).toBe(expected)
  }
)

it('decodes each committed side using the attributes that normalized its blob', async ({
  skip
}) => {
  const { repo, git } = createRepo()
  git('config', 'user.name', 'Orca Test')
  git('config', 'user.email', 'orca@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  const filePath = 'sample.c'
  // c2 a9 is 漏 in GB18030 and © in UTF-8.
  writeFileSync(join(repo, filePath), Buffer.from('c2a9', 'hex'))
  git('add', filePath)
  git('commit', '-qm', 'raw GB18030')
  const parentOid = git('rev-parse', 'HEAD')
  skip(
    spawnSync('git', ['check-attr', '--source=HEAD', 'working-tree-encoding', '--', filePath], {
      cwd: repo
    }).status !== 0,
    'This Git cannot read attributes from a historical tree'
  )

  writeFileSync(join(repo, '.gitattributes'), 'sample.c working-tree-encoding=GB18030\n')
  git('add', '.gitattributes')
  git('add', '--renormalize', filePath)
  git('commit', '-qm', 'normalize the same character')
  const commitOid = git('rev-parse', 'HEAD')
  const read = () =>
    getCommitDiff(repo, { filePath, parentOid, commitOid }, { encoding: 'gb18030' })
  expect(await read()).toMatchObject({ originalContent: '漏', modifiedContent: '漏' })

  git('rm', '.gitattributes')
  expect(await read()).toMatchObject({ originalContent: '漏', modifiedContent: '漏' })
})

it.each([
  { stagedRule: 'working-tree-encoding=GB18030', checkoutRule: '-working-tree-encoding' },
  { stagedRule: '-working-tree-encoding', checkoutRule: 'working-tree-encoding=GB18030' }
])(
  'keeps staged text readable after changing $stagedRule only on disk',
  async ({ stagedRule, checkoutRule }) => {
    const { repo, git } = createRepo()
    const filePath = 'sample.c'
    const attributes = join(repo, '.gitattributes')
    writeFileSync(attributes, `sample.c ${stagedRule}\n`)
    writeFileSync(join(repo, filePath), Buffer.from('c2a9', 'hex'))
    git('add', '.gitattributes', filePath)
    writeFileSync(attributes, `sample.c ${checkoutRule}\n`)

    const options = { encoding: 'gb18030' } as const
    expect((await getDiff(repo, filePath, true, false, options)).modifiedContent).toBe('漏')
    expect((await getDiff(repo, filePath, false, false, options)).originalContent).toBe('漏')
  }
)
