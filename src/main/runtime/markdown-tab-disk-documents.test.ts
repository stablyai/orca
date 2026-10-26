import { describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES
} from '../../shared/mobile-markdown-document'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getDiskBaselineSignature } from '../../shared/disk-baseline-signature'
import { compareDiskWritePrecondition } from '../../shared/file-write-disk-precondition'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import {
  readMarkdownTabFromDisk,
  saveMarkdownTabToDisk,
  type ListedMarkdownTab,
  type MarkdownTabDiskHost
} from './markdown-tab-disk-documents'

const WORKTREE = 'repo::/srv/repo'
const FILE_PATH = '/srv/repo/README.md'
const TAB: ListedMarkdownTab = {
  id: FILE_PATH,
  mode: 'edit',
  filePath: FILE_PATH,
  sourceFilePath: FILE_PATH,
  sourceRelativePath: 'README.md',
  isDirty: false
}

function makeHost(disk: string, draft?: string, saved: Partial<PersistedOpenFile> = {}) {
  const file: PersistedOpenFile = {
    filePath: FILE_PATH,
    relativePath: 'README.md',
    worktreeId: WORKTREE,
    language: 'markdown',
    runtimeEnvironmentId: null,
    ...(draft === undefined
      ? {}
      : { dirtyDraftContent: draft, lastKnownDiskSignature: getDiskBaselineSignature(disk) }),
    ...saved
  }
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: { [WORKTREE]: [file] }
  }
  const state = { disk }
  const io = {
    readFile: vi.fn(async (_worktreeId: string, _file: { filePath: string }, maxBytes: number) => {
      const bytes = Buffer.from(state.disk)
      return { content: bytes.subarray(0, maxBytes).toString('utf8'), byteLength: bytes.length }
    }),
    writeFileIfUnchanged: vi.fn(
      async (
        _worktreeId: string,
        _file: { filePath: string },
        content: string,
        precondition: { expectedSignature: string }
      ) => {
        const comparison = compareDiskWritePrecondition(precondition, state.disk, content)
        if (comparison === 'identical') {
          return { ok: true as const, unchanged: true }
        }
        if (comparison) {
          return { ok: false as const, diskConflict: 'changed' as const }
        }
        state.disk = content
        return { ok: true as const }
      }
    )
  }
  const host = {
    ...io,
    getWorkspaceSessionForWorktree: () => session,
    forSave: async () => io
  } satisfies MarkdownTabDiskHost
  return { host, state }
}

describe('Markdown tab documents on disk', () => {
  it('reads the file from disk when the tab has no saved draft', async () => {
    const { host } = makeHost('# Notes\n')

    await expect(readMarkdownTabFromDisk(host, WORKTREE, TAB)).resolves.toEqual({
      tabId: FILE_PATH,
      filePath: FILE_PATH,
      relativePath: 'README.md',
      content: '# Notes\n',
      isDirty: false,
      version: hashMarkdownContent('# Notes\n'),
      source: 'file',
      editable: true
    })
  })

  it('reads the disk, never unsaved desktop text, and reports the tab dirty as it was listed', async () => {
    const { host } = makeHost('# Disk\n', '# Draft\n')

    await expect(
      readMarkdownTabFromDisk(host, WORKTREE, { ...TAB, isDirty: true })
    ).resolves.toMatchObject({
      content: '# Disk\n',
      isDirty: true,
      source: 'file',
      editable: true,
      version: hashMarkdownContent('# Disk\n')
    })
  })

  it("reads a preview tab's source file, read-only", async () => {
    const { host } = makeHost('# Notes\n')
    const preview: ListedMarkdownTab = {
      ...TAB,
      id: `markdown-preview::${FILE_PATH}`,
      mode: 'markdown-preview'
    }

    await expect(readMarkdownTabFromDisk(host, WORKTREE, preview)).resolves.toMatchObject({
      tabId: preview.id,
      filePath: FILE_PATH,
      content: '# Notes\n',
      editable: false,
      readOnlyReason: 'unsupported_preview'
    })
    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, preview, hashMarkdownContent('# Notes\n'), '# Edit\n')
    ).rejects.toThrow('unsupported_preview')
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('marks a read truncated when the host sent less than the whole file', async () => {
    const { host } = makeHost('# Notes\n')
    host.readFile.mockResolvedValueOnce({ content: 'a'.repeat(10), byteLength: 600_000 })

    await expect(readMarkdownTabFromDisk(host, WORKTREE, TAB)).resolves.toMatchObject({
      truncated: true,
      byteLength: 600_000,
      editable: false,
      readOnlyReason: 'file_too_large'
    })
  })

  it('marks a file over the edit cap read-only, and a file over the read cap truncated', async () => {
    const editable = makeHost('a'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1))
    await expect(readMarkdownTabFromDisk(editable.host, WORKTREE, TAB)).resolves.toMatchObject({
      editable: false,
      readOnlyReason: 'file_too_large'
    })

    const size = MOBILE_MARKDOWN_READ_MAX_BYTES + 10
    const large = makeHost('a'.repeat(size))
    const read = await readMarkdownTabFromDisk(large.host, WORKTREE, TAB)
    expect(read).toMatchObject({ truncated: true, byteLength: size, editable: false })
    expect(Buffer.byteLength(read.content)).toBe(MOBILE_MARKDOWN_READ_MAX_BYTES)
    expect(read.version).toBe(hashMarkdownContent(read.content))
  })

  it('saves over the version the phone read, refusing any change on disk since', async () => {
    const { host, state } = makeHost('# Notes\n')

    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# New\n')
    ).resolves.toEqual({
      tabId: FILE_PATH,
      version: hashMarkdownContent('# New\n'),
      isDirty: false,
      content: '# New\n'
    })
    expect(state.disk).toBe('# New\n')
    expect(host.writeFileIfUnchanged).toHaveBeenCalledWith(
      WORKTREE,
      expect.objectContaining({ filePath: FILE_PATH }),
      '# New\n',
      {
        expectedSignature: getDiskBaselineSignature('# Notes\n')
      }
    )
  })

  it('refuses a save from a stale version and leaves the disk alone', async () => {
    const { host, state } = makeHost('# Changed on the server\n')

    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# Phone\n')
    ).rejects.toThrow('conflict')
    expect(state.disk).toBe('# Changed on the server\n')
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('answers a repeated save that already landed as saved', async () => {
    const { host } = makeHost('# New\n')

    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# New\n')
    ).resolves.toMatchObject({ content: '# New\n', isDirty: false })
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('refuses when the disk changes between the read and the write', async () => {
    const { host, state } = makeHost('# Notes\n')
    host.readFile.mockImplementationOnce(async () => {
      const read = { content: state.disk, byteLength: Buffer.byteLength(state.disk) }
      state.disk = '# Raced\n'
      return read
    })

    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# Phone\n')
    ).rejects.toThrow('conflict')
    expect(state.disk).toBe('# Raced\n')
  })

  it("saves the disk, leaving a window's saved draft for that window", async () => {
    const { host, state } = makeHost('# Disk\n', '# Draft\n')

    await saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Disk\n'), '# Phone\n')

    expect(state.disk).toBe('# Phone\n')
  })

  it('runs two saves of one file one after the other', async () => {
    const { host, state } = makeHost('# Notes\n')
    const base = hashMarkdownContent('# Notes\n')

    const results = await Promise.all([
      saveMarkdownTabToDisk(host, WORKTREE, TAB, base, '# Same\n'),
      saveMarkdownTabToDisk(host, WORKTREE, TAB, base, '# Same\n')
    ])

    expect(results.map((result) => result.content)).toEqual(['# Same\n', '# Same\n'])
    expect(host.writeFileIfUnchanged).toHaveBeenCalledTimes(1)
    expect(state.disk).toBe('# Same\n')
  })

  it('keeps saving after a failed save of the same file', async () => {
    const { host, state } = makeHost('# Notes\n')
    host.writeFileIfUnchanged.mockRejectedValueOnce(new Error('EACCES'))
    const base = hashMarkdownContent('# Notes\n')

    await expect(saveMarkdownTabToDisk(host, WORKTREE, TAB, base, '# First\n')).rejects.toThrow(
      'EACCES'
    )
    await saveMarkdownTabToDisk(host, WORKTREE, TAB, base, '# Second\n')

    expect(state.disk).toBe('# Second\n')
  })

  it('never saves a read-only tab', async () => {
    const { host } = makeHost('# Log\n', undefined, { readOnly: true })

    await expect(readMarkdownTabFromDisk(host, WORKTREE, TAB)).resolves.toMatchObject({
      editable: false,
      readOnlyReason: 'unsupported_tab'
    })
    await expect(
      saveMarkdownTabToDisk(host, WORKTREE, TAB, hashMarkdownContent('# Log\n'), '# Edit\n')
    ).rejects.toThrow('unsupported_tab')
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('refuses a tab the saved session no longer holds', async () => {
    const { host } = makeHost('# Notes\n')

    await expect(
      readMarkdownTabFromDisk(host, WORKTREE, {
        ...TAB,
        id: 'gone',
        sourceFilePath: '/srv/repo/GONE.md'
      })
    ).rejects.toThrow('tab_not_found')
  })
})
