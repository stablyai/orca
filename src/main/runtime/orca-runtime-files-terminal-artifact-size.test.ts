import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { renameMock, resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import { TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES } from '../../shared/runtime-file-contracts'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)

// Past a phone's 512 KB, inside a desktop client's budget.
const LARGE_TEXT = 'x'.repeat(600 * 1024)

describe('a granted file larger than a phone reads', () => {
  useRuntimeFileCommandsLifecycle()
  const { tempFile } = useTerminalArtifactTempFiles()

  async function grantLargeFile() {
    const artifactPath = await tempFile('package-lock.json', LARGE_TEXT)
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    const result = await resolveTerminalArtifactPath(commands, artifactPath)
    return { artifactPath, commands, result, target: absoluteFileTarget(result) }
  }

  it('reports its size with the grant', async () => {
    const { result } = await grantLargeFile()

    expect(result.openTarget).toMatchObject({ byteLength: LARGE_TEXT.length })
  })

  it('reads whole for a desktop budget and refuses a phone', async () => {
    const { commands, target } = await grantLargeFile()
    const read = (maxTextBytes?: number) =>
      commands.readTerminalArtifactFile(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        'client-a',
        maxTextBytes
      )

    await expect(read(TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES)).resolves.toMatchObject({
      content: LARGE_TEXT,
      truncated: false
    })
    await expect(read()).rejects.toThrow('file_too_large')
  })

  it('saves over it for a desktop budget and refuses a phone', async () => {
    const { artifactPath, commands, target } = await grantLargeFile()
    renameMock.mockImplementation(async (from, to) => writeFile(to, await readFile(from)))
    const edited = `${LARGE_TEXT}y`
    const write = (maxTextBytes?: number) =>
      commands.writeTerminalArtifactFile(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        edited,
        'client-a',
        maxTextBytes
      )

    await expect(write()).rejects.toThrow('file_too_large')
    await expect(write(TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES)).resolves.toEqual({ ok: true })
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe(edited)
  })
})
