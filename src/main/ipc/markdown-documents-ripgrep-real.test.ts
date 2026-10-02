import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBundledRipgrepPathCacheForTests } from '../ripgrep/bundled-ripgrep-path'
import { listMarkdownDocuments } from './markdown-documents'

describe('Markdown listing with bundled ripgrep', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca Markdown 日本語 '))
    resetBundledRipgrepPathCacheForTests()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    resetBundledRipgrepPathCacheForTests()
    await rm(root, { recursive: true, force: true })
  })

  async function put(relativePath: string, content = 'document'): Promise<void> {
    const filePath = join(root, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }

  it('preserves Markdown visibility independently of ignore files and rg configuration', async () => {
    const included = [
      'README.md',
      'Guide.MDX',
      'docs/Notes.MARKDOWN',
      '.hidden.md',
      'docs/.hidden.mdx',
      '.github/CONTRIBUTING.md',
      'docs/.github/nested/guide.md',
      '.github/normal/.hidden.md',
      'ignored-git/readme.md',
      'ignored-rg/readme.md',
      'ignored-dot/readme.md',
      'space folder/日本語 document.md',
      'uppercase/NODE_MODULES/visible.md'
    ]
    const excluded = [
      'plain.txt',
      '.md',
      'docs/.MDX',
      '.git/hidden.md',
      'node_modules/hidden.md',
      'docs/node_modules/hidden.md',
      '.hidden/hidden.md',
      '.hidden/.github/hidden.md',
      '.github/.hidden/hidden.md',
      '.github/node_modules/hidden.md',
      '.github/.md/hidden.md',
      '.github.txt/hidden.md',
      'docs/.md/hidden.md'
    ]
    for (const filePath of [...included, ...excluded]) {
      await put(filePath)
    }
    await put('.gitignore', 'ignored-git/\n')
    await put('.rgignore', 'ignored-rg/\n')
    await put('.ignore', 'ignored-dot/\n')
    await put('rg-config', '--glob=!*.md\n')
    vi.stubEnv('RIPGREP_CONFIG_PATH', join(root, 'rg-config'))

    expect(await listMarkdownDocuments(root)).toEqual(
      included
        .sort((left, right) => left.localeCompare(right))
        .map((relativePath) => ({
          filePath: join(root, relativePath),
          relativePath,
          basename: basename(relativePath),
          name: basename(relativePath, extname(relativePath))
        }))
    )
  })

  it('does not follow directory links or file links', async () => {
    await put('docs/original.md')
    await symlink(
      join(root, 'docs'),
      join(root, 'linked-docs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    // File symlinks require privileges that Windows test runners may not have.
    if (process.platform !== 'win32') {
      await symlink(join(root, 'docs/original.md'), join(root, 'linked.md'))
      await symlink(join(root, 'missing.md'), join(root, 'broken.md'))
    }
    expect((await listMarkdownDocuments(root)).map((document) => document.relativePath)).toEqual([
      'docs/original.md'
    ])
  })

  it.skipIf(process.platform === 'win32')('preserves line breaks in filenames', async () => {
    const names = ['line\nbreak.md', 'carriage\rreturn.MDX', 'nested\nfolder/文書.md']
    for (const name of names) {
      await put(name)
    }
    expect((await listMarkdownDocuments(root)).map((document) => document.relativePath)).toEqual(
      names.sort((left, right) => left.localeCompare(right))
    )
  })

  it('returns an empty list for an empty ordinary folder', async () => {
    await expect(listMarkdownDocuments(root)).resolves.toEqual([])
  })

  it('rejects a missing root rather than treating it as an empty folder', async () => {
    await expect(listMarkdownDocuments(join(root, 'missing'))).rejects.toThrow()
  })
})
