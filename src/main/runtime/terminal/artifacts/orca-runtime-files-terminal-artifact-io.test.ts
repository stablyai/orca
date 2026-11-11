import {
  createTerminalArtifactSubjects,
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  renameMock,
  resolveAuthorizedPathMock,
  statMock
} from '../../files/runtime-file-command-mock-registry'
import { useRuntimeFileHostLifecycle } from '../../files/runtime-file-host.test-fixture'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES
} from '../../files/file-preview-budget'

vi.mock('fs', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).fsModuleMock()
)
vi.mock('fs/promises', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  '../../files/watch/file-watcher-host',
  async () => (await import('../../files/runtime-file-command-mock-registry')).fileWatcherHostMock
)
vi.mock('../../../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../../../git/runner', async () =>
  (await import('../../files/runtime-file-command-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../../../ipc/local-worktree-runtime-options',
  async () =>
    (await import('../../files/runtime-file-command-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeTerminalArtifacts', () => {
  useRuntimeFileHostLifecycle()

  describe('resolveTerminalPath', () => {
    const { tempFile } = useTerminalArtifactTempFiles()

    it('reads an absolute terminal artifact only for the client that received the grant', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 11, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({
        relativePath: target.absolutePath,
        content: '{"ok":true}',
        truncated: false
      })
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-b'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
    })

    it('rejects stale absolute terminal artifact writes before changing the file', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":"ext"}')

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":"ext"}')
    })

    it('lets only one of two concurrent writes from different clients land', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      // The registry stubs rename; commit for real so the second writer sees the first one's bytes.
      renameMock.mockImplementation(async (from, to) => writeFile(to, await readFile(from)))

      const first = absoluteFileTarget(await resolveTerminalArtifactPath(paths, artifactPath))
      const second = absoluteFileTarget(
        await resolveTerminalArtifactPath(paths, artifactPath, null, 'client-b')
      )

      const results = await Promise.allSettled([
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          first.grantId,
          first.absolutePath,
          '{"from":"a"}',
          'client-a'
        ),
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          second.grantId,
          second.absolutePath,
          '{"from":"b"}',
          'client-b'
        )
      ])

      const winner = results.findIndex((result) => result.status === 'fulfilled')
      expect(results[1 - winner]).toMatchObject({
        status: 'rejected',
        reason: new Error('terminal_file_grant_stale')
      })
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe(
        winner === 0 ? '{"from":"a"}' : '{"from":"b"}'
      )
    })

    it('keeps the original terminal artifact when atomic commit fails', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      renameMock.mockRejectedValueOnce(new Error('ENOSPC'))

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('ENOSPC')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":true}')
    })

    it('pages a granted binary file whole, beyond the text read cap, for its client only', async () => {
      const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab)
      bytes[0] = 0
      const artifactPath = await tempFile('teste.mp4', '')
      await writeFile(artifactPath, bytes)
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      const target = absoluteFileTarget(await resolveTerminalArtifactPath(paths, artifactPath))
      const readPage = (offset: number, clientId = 'client-a') =>
        commands.readTerminalArtifactChunk(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          offset,
          512 * 1024,
          clientId
        )

      const pages: Buffer[] = []
      for (let offset = 0, eof = false; !eof;) {
        const page = await readPage(offset)
        pages.push(Buffer.from(page.contentBase64, 'base64'))
        offset += page.bytesRead
        eof = page.eof
      }

      expect(Buffer.concat(pages).equals(bytes)).toBe(true)
      await expect(readPage(0, 'client-b')).rejects.toThrow()
    })

    // Why: files above the digest cap are pinned by stat alone; utimes can restore mtime but never ctime.
    it('rejects a page of a large granted file rewritten in place with its mtime restored', async () => {
      const artifactPath = await tempFile('render.mp4', '')
      await writeFile(artifactPath, Buffer.alloc(LOCAL_PREVIEWABLE_BINARY_MAX_BYTES + 1, 0xab))
      // Whole seconds, so restoring them reproduces the granted mtime exactly.
      const pinnedSeconds = 1_700_000_000
      await utimes(artifactPath, pinnedSeconds, pinnedSeconds)
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      const target = absoluteFileTarget(await resolveTerminalArtifactPath(paths, artifactPath))

      const handle = await open(artifactPath, 'r+')
      const grantedCtimeMs = (await handle.stat()).ctimeMs
      // Why: coarse-tick filesystems can stamp a quick rewrite with the granted ctime; rewrite until it moves.
      do {
        await handle.write(Buffer.alloc(16, 0xcd), 0, 16, 0)
        await handle.utimes(pinnedSeconds, pinnedSeconds)
      } while ((await handle.stat()).ctimeMs === grantedCtimeMs)
      await handle.close()

      await expect(
        commands.readTerminalArtifactChunk(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          0,
          512 * 1024,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact reads before returning outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact writes before changing outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(outsidePath, 'utf8')).resolves.toBe('{"secret":true}')
    })

    it('keeps local terminal artifact previews above the remote cap available', async () => {
      const size = RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1
      const artifactPath = await tempFile('result.png', 'a'.repeat(size))
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({
        content: Buffer.alloc(size, 0x61).toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })

    it('rejects binary-extension terminal artifacts from the editable text path', async () => {
      const artifactPath = await tempFile('report.pdf', '%PDF text-looking bytes')
      const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({
        isDirectory: () => false,
        size: 23,
        dev: 1,
        ino: 2,
        mtimeMs: 3
      })

      const result = await resolveTerminalArtifactPath(paths, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'not a pdf',
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('%PDF text-looking bytes')
    })
  })
})
