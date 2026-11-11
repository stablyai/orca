import {
  createTerminalArtifactSubjects,
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { openMock, resolveAuthorizedPathMock } from '../../files/runtime-file-command-mock-registry'
import { useRuntimeFileHostLifecycle } from '../../files/runtime-file-host.test-fixture'

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

/** Linux can reuse an inode within one mtime tick after same-size unlink/recreate; replay identical stats
 * so swap detection cannot rely on inode, nlink, size or coarse mtime changing. */
function replayFirstStatPerPath(): void {
  const frozen = new Map<string, unknown>()
  openMock.mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof FsPromises>('fs/promises')
    const handle = await actual.open(...args)
    const key = String(args[0])
    return {
      stat: async () => {
        if (!frozen.has(key)) {
          frozen.set(key, await handle.stat())
        }
        return frozen.get(key)
      },
      read: (...readArgs: Parameters<typeof handle.read>) => handle.read(...readArgs),
      close: () => handle.close()
    }
  })
}

describe('terminal artifact swap detection', () => {
  useRuntimeFileHostLifecycle()

  const { tempFile } = useTerminalArtifactTempFiles()

  async function grantFor(artifactPath: string) {
    const { paths, commands } = createTerminalArtifactSubjects({ path: '/repo' })
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    const result = await resolveTerminalArtifactPath(paths, artifactPath)
    return { commands, target: absoluteFileTarget(result) }
  }

  it('rejects a same-size preview swap that the granted stat cannot tell apart', async () => {
    replayFirstStatPerPath()
    const artifactPath = await tempFile('result.png', 'fake-png')
    const { commands, target } = await grantFor(artifactPath)

    await rm(artifactPath)
    await writeFile(artifactPath, 'changed!')

    await expect(
      commands.readTerminalArtifactPreview(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        'client-a'
      )
    ).rejects.toThrow('terminal_file_grant_stale')
  })

  it('rejects a same-size read swap that the granted stat cannot tell apart', async () => {
    replayFirstStatPerPath()
    const artifactPath = await tempFile('result.json', '{"ok":true}')
    const { commands, target } = await grantFor(artifactPath)

    await rm(artifactPath)
    await writeFile(artifactPath, '{"ok":ext}')

    await expect(
      commands.readTerminalArtifactFile('id:wt-1', target.grantId, target.absolutePath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_stale')
  })

  it('rejects a same-size write swap before the file is changed', async () => {
    replayFirstStatPerPath()
    const artifactPath = await tempFile('result.json', '{"ok":true}')
    const { commands, target } = await grantFor(artifactPath)

    await rm(artifactPath)
    await writeFile(artifactPath, '{"ok":ext}')

    await expect(
      commands.writeTerminalArtifactFile(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        '{"ok":no}',
        'client-a'
      )
    ).rejects.toThrow('terminal_file_grant_stale')
  })

  // Untouched control must pass; otherwise swap rejection proves nothing.
  it('still serves an untouched artifact under the same replayed stat', async () => {
    replayFirstStatPerPath()
    const artifactPath = await tempFile('result.png', 'fake-png')
    const { commands, target } = await grantFor(artifactPath)

    await expect(
      commands.readTerminalArtifactPreview(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        'client-a'
      )
    ).resolves.toMatchObject({
      content: Buffer.from('fake-png').toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })
})
