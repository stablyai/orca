import { describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { openMock, resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

/**
 * Replays the first stat seen for a path on every later open of it. That is what Linux hands the
 * grant check for free after an unlink+recreate: ext4 reuses the just-freed inode, nlink and size
 * are unchanged for a same-size swap, and the coarse mtime clock only advances once per timer tick
 * (measured: 1ms), so a swap inside one tick is byte-for-byte identical to the granted stat.
 */
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
  useRuntimeFileCommandsLifecycle()

  const { tempFile } = useTerminalArtifactTempFiles()

  async function grantFor(artifactPath: string) {
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    const result = await resolveTerminalArtifactPath(commands, artifactPath)
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

  // Control: the replayed stat alone must not reject, or the swap cases above prove nothing.
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
