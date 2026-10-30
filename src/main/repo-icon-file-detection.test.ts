import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { resolveFilesystemRouteForHost } from './providers/execution-host-provider-dispatch'
import { detectRepoFileIcon } from './repo-icon-file-detection'

// Spy on real fs entrypoints so accidental local reads cannot hide behind stubs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
})

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

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

  it('still probes the local filesystem for a repo on this machine', async () => {
    vi.mocked(stat).mockClear()

    await expect(
      detectRepoFileIcon('/repo', resolveFilesystemRouteForHost('local'))
    ).resolves.toBeNull()

    expect(stat).toHaveBeenCalled()
  })
})

describe('declared repo icons through production filesystem routes', () => {
  it.each([false, true])('preserves declared icon detection (no icon: %s)', async (noIcon) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-icon-href-'))
    const source = noIcon
      ? 'a'.repeat(256 * 1024)
      : `${'a'.repeat(32768)}{ rel: "icon", href: "/first.png", href: "/chosen.png" }`
    try {
      await mkdir(join(directory, 'public'))
      await writeFile(join(directory, 'index.html'), source)
      await writeFile(join(directory, 'public', 'chosen.png'), Buffer.from(PNG_BASE64, 'base64'))
      await expect(
        detectRepoFileIcon(directory, resolveFilesystemRouteForHost('local'))
      ).resolves.toEqual(
        noIcon
          ? null
          : {
              type: 'image',
              src: `data:image/png;base64,${PNG_BASE64}`,
              source: 'file',
              label: 'public/chosen.png'
            }
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
