import { describe, expect, it, vi } from 'vitest'
import { constants, open, rm, writeFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
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
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
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

  it.skipIf(process.platform === 'win32').each(['read', 'preview', 'write'] as const)(
    'refuses a FIFO replacement promptly during grant %s consumption',
    async (operation) => {
      vi.useRealTimers()
      const artifactPath = await tempFile('result.txt', 'original')
      const { commands, target } = await grantFor(artifactPath)
      await rm(artifactPath)
      const fifo = await runProcess({ program: 'mkfifo', args: [artifactPath], timeoutMs: 2000 })
      expect(fifo.code).toBe(0)
      const args = ['id:wt-1', target.grantId, target.absolutePath] as const
      const action =
        operation === 'read'
          ? commands.readTerminalArtifactFile(...args, 'client-a')
          : operation === 'preview'
            ? commands.readTerminalArtifactPreview(...args, 'client-a')
            : commands.writeTerminalArtifactFile(...args, 'changed', 'client-a')
      const pending = action.then(
        () => 'accepted',
        (error: Error) => error.message
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          pending,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('blocked'), 500)
          })
        ])
        if (outcome === 'blocked') {
          // Release a regressed blocking reader so a failing test leaves no filesystem job behind.
          const writer = await open(artifactPath, constants.O_WRONLY | constants.O_NONBLOCK).catch(
            () => null
          )
          await writer?.close()
          await pending
        }
        expect(outcome).toBe('terminal_file_grant_stale')
      } finally {
        clearTimeout(timer)
      }
    }
  )

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
