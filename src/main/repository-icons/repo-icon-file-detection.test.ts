import { readFile, stat } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { resolveFilesystemRouteForHost } from '../providers/execution-host-provider-dispatch'
import { detectRepoFileIcon } from './repo-icon-file-detection'

// Spy on real fs entrypoints so accidental local reads cannot hide behind stubs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
})

describe('detectRepoFileIcon connection boundary', () => {
  it('never reads the client filesystem for a repo on an SSH target', async () => {
    vi.mocked(stat).mockClear()
    vi.mocked(readFile).mockClear()

    await expect(
      detectRepoFileIcon('/repo', resolveFilesystemRouteForHost('ssh:ssh-target-1'))
    ).resolves.toBeNull()

    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('never reads the client filesystem for a runtime host', async () => {
    vi.mocked(stat).mockClear()
    vi.mocked(readFile).mockClear()

    await expect(
      detectRepoFileIcon('/repo', {
        kind: 'runtime',
        hostId: 'runtime:env-a',
        environmentId: 'env-a'
      })
    ).resolves.toBeNull()

    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})
