import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { bundledRipgrepCommand } from '../main/ripgrep/bundled-ripgrep-path'
import { isMarkdownDocumentName } from '../shared/markdown-document-paths'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'
import { listFilesWithRg } from './fs-handler-list-files'
import { listRelayMarkdownDocuments } from './fs-markdown-document-listing'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import type { RelayDispatcher } from '../wsl-guest/dispatcher'

it.skipIf(process.platform === 'win32')(
  'keeps readable SSH Markdown documents when a child directory is unreadable',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-markdown-permissions-'))
    const locked = join(root, 'locked')
    configureRelayBundledRipgrep(bundledRipgrepCommand())
    try {
      await mkdir(locked)
      await writeFile(join(root, 'README.md'), '')
      await writeFile(join(locked, 'private.md'), '')
      await chmod(locked, 0)
      expect(await listFilesWithRg(root)).toEqual(['README.md'])
      await expect(listRelayMarkdownDocuments(root)).resolves.toEqual([
        {
          filePath: join(root, 'README.md'),
          relativePath: 'README.md',
          basename: 'README.md',
          name: 'README'
        }
      ])
    } finally {
      await chmod(locked, 0o700)
      configureRelayBundledRipgrep(undefined)
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('keeps Markdown discovery useful on folder hosts without uploaded or PATH ripgrep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-markdown-no-rg-'))
  configureRelayBundledRipgrep(undefined)
  vi.stubEnv('PATH', root)
  vi.stubEnv('Path', root)
  vi.stubEnv('CARGO_HOME', root)
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const dispatcher = {
    onRequest: (method: string, callback: (params: Record<string, unknown>) => Promise<unknown>) =>
      handlers.set(method, callback),
    onNotification: vi.fn(),
    onClientDetached: vi.fn(() => () => {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Filesystem registration uses only the three dispatcher hooks supplied by this fixture.
  const handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  try {
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude', 'instructions.md'), '')
    await writeFile(join(root, 'README.md'), '')
    const listMarkdown = handlers.get('fs.listMarkdownDocuments')
    if (!listMarkdown) {
      throw new Error('Markdown discovery handler is missing')
    }
    await expect(listMarkdown({ rootPath: root })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: '.claude/instructions.md' }),
        expect.objectContaining({ relativePath: 'README.md' })
      ])
    )
  } finally {
    handler.dispose()
    vi.unstubAllEnvs()
    configureRelayBundledRipgrep(undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves SSH Markdown visibility when discovery moves off the full file inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-markdown-'))
  configureRelayBundledRipgrep(bundledRipgrepCommand())
  try {
    for (const path of [
      'README.md',
      '.config/settings.md',
      '.claude/instructions.MDX',
      '.github/template.md',
      '.cache/hidden.md',
      'node_modules/dependency.md',
      'ignored.md',
      'excluded.md',
      'source.ts'
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), '')
    }
    await writeFile(join(root, '.gitignore'), 'ignored.md\n')
    await writeFile(join(root, '.ignore'), 'excluded.md\n')
    const baseline = (await listFilesWithRg(root)).filter(isMarkdownDocumentName).sort()
    expect(baseline).toEqual([
      '.claude/instructions.MDX',
      '.config/settings.md',
      '.github/template.md',
      'README.md',
      'ignored.md'
    ])
    const documents = await listRelayMarkdownDocuments(root)
    expect(documents.map((document) => document.relativePath).sort()).toEqual(baseline)
  } finally {
    configureRelayBundledRipgrep(undefined)
    await rm(root, { recursive: true, force: true })
  }
})
