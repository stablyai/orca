import { listSshFiles } from './ssh-file-listing'
import { describe, expect, it, vi } from 'vitest'
import { readSshMarkdownDocuments } from './ssh-markdown-document-listing'
import { readSshDirectoryBounded } from './ssh-directory-listing'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

function muxFixture(result: unknown, error?: Error) {
  const mock = {
    request: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(result),
    notify: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    onNotificationByMethod: vi.fn(() => () => {}),
    onDispose: vi.fn(() => () => {}),
    isDisposed: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The reader uses only these request, notification, and disposal operations.
  return { mock, mux: mock as unknown as SshChannelMultiplexer }
}
const unsupported = () => Object.assign(new Error('Method not found'), { code: -32601 })

describe('SSH listing compatibility', () => {
  it('accepts late full-inventory files in old plain replies without a count cap', async () => {
    const paths = Array.from({ length: 25002 }, (_, i) => `src/file-${i}.ts`)
    const { mux, mock } = muxFixture(paths)
    expect((await listSshFiles(mux, '/repo')).at(-1)).toBe('src/file-25001.ts')
    expect(mock.request.mock.calls[0][1].maxResults).toBeUndefined()
    const limited = muxFixture(paths.slice(0, 3))
    expect(await listSshFiles(limited.mux, '/repo', { maxResults: 3 })).toHaveLength(3)
  })

  it('keeps complete small old-peer Markdown inventories useful', async () => {
    const { mux } = muxFixture(undefined, unsupported())
    const loadLegacy = vi.fn().mockResolvedValue(['source.ts', 'docs/README.md'])
    const result = await readSshMarkdownDocuments(mux, '/repo', undefined, loadLegacy)
    expect(result.map((document) => document.relativePath)).toEqual(['docs/README.md'])
    expect(loadLegacy).toHaveBeenCalledTimes(1)
  })

  it('keeps late Markdown files in large old-peer source inventories', async () => {
    const paths = Array.from({ length: 25_002 }, (_, index) => `src/file-${index}.ts`)
    paths.push('docs/late.md')
    const { mux, mock } = muxFixture(paths)
    mock.request.mockRejectedValueOnce(unsupported())
    const provider = new SshFilesystemProvider('legacy', mux)
    await expect(provider.listMarkdownDocuments('/repo')).resolves.toEqual([
      {
        filePath: '/repo/docs/late.md',
        relativePath: 'docs/late.md',
        basename: 'late.md',
        name: 'late'
      }
    ])
    expect(mock.request).toHaveBeenLastCalledWith('fs.listFiles', {
      rootPath: '/repo',
      __streamResponse: true
    })
    provider.dispose()
  })

  it('still rejects an old-peer inventory with too many Markdown documents', async () => {
    const { mux } = muxFixture(undefined, unsupported())
    await expect(
      readSshMarkdownDocuments(mux, '/repo', undefined, async () => Array(20_001).fill('source.md'))
    ).rejects.toThrow('Workspace is too large')
  })

  it('uses bounded SFTP fallback for old directory peers and preserves failures', async () => {
    const { mux } = muxFixture(undefined, unsupported())
    const fallback = vi
      .fn()
      .mockResolvedValue([{ name: 'folder', isDirectory: true, isSymlink: false }])
    expect(await readSshDirectoryBounded(mux, '/repo', fallback)).toHaveLength(1)
    const failure = muxFixture(undefined, new Error('Permission denied'))
    await expect(readSshDirectoryBounded(failure.mux, '/repo', fallback)).rejects.toThrow(
      'Permission denied'
    )
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('validates new-peer directory and Markdown metadata before exposing it', async () => {
    const directory = muxFixture([
      { name: 'x'.repeat(5 * 1024 * 1024), isDirectory: false, isSymlink: false }
    ])
    await expect(readSshDirectoryBounded(directory.mux, '/repo')).rejects.toThrow()
    const markdown = muxFixture(
      Array.from({ length: 20_001 }, () => ({
        filePath: '/repo/a.md',
        relativePath: 'a.md',
        basename: 'a.md',
        name: 'a'
      }))
    )
    await expect(readSshMarkdownDocuments(markdown.mux, '/repo')).rejects.toThrow(
      'Workspace is too large'
    )
  })
})
