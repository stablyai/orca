import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJimp } from '@jimp/core'
import png from '@jimp/js-png'
import { resolveAuthorizedPathMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  resolveTerminalArtifactPath
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
vi.mock('./runtime-image-preview-worker', async () => {
  const { shrinkImagePreview } = await import('./runtime-image-preview-codec')
  return { shrinkImagePreviewInWorker: shrinkImagePreview }
})

describe('runtime image preview routes', () => {
  useRuntimeFileCommandsLifecycle()
  const directories: string[] = []
  const budget = 16 * 1024
  afterEach(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })))
    directories.length = 0
  })

  async function fixture() {
    vi.useRealTimers()
    const Image = createJimp({ formats: [png] })
    const image = new Image({ width: 320, height: 240 })
    let seed = 12345
    for (let offset = 0; offset < image.bitmap.data.length; offset++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      image.bitmap.data[offset] = offset % 4 === 3 ? 255 : seed >>> 24
    }
    const bytes = await image.getBuffer('image/png')
    const directory = await mkdtemp(join(tmpdir(), 'orca-image-route-'))
    directories.push(directory)
    const path = join(directory, 'photo.png')
    await writeFile(path, bytes)
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    return { bytes, directory, path }
  }

  it('resizes file-explorer previews without modifying the on-disk original', async () => {
    const { bytes, directory, path } = await fixture()
    const { commands } = createRuntimeFileCommands({ path: directory })
    const result = await commands.readFileExplorerPreview('id:wt-1', 'photo.png', budget)
    expect(result.mimeType).toBe('image/jpeg')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget)
    expect(await readFile(path)).toEqual(bytes)
  })

  it('resizes local terminal artifacts after checking the client grant', async () => {
    const { bytes, path } = await fixture()
    const { commands } = createRuntimeFileCommands({ path: '/repo' })
    const target = absoluteFileTarget(await resolveTerminalArtifactPath(commands, path))
    const result = await commands.readTerminalArtifactPreview(
      'id:wt-1',
      target.grantId,
      target.absolutePath,
      'client-a',
      budget
    )
    expect(result.mimeType).toBe('image/jpeg')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget)
    expect(await readFile(path)).toEqual(bytes)
    await expect(
      commands.readTerminalArtifactPreview(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        'client-b',
        budget
      )
    ).rejects.toThrow('terminal_file_grant_mismatch')
  })
})
