import { readFile, stat } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostFilesystemRoute } from './providers/execution-host-provider-dispatch'
import type { FileReadResult, FileStat, IFilesystemProvider } from './providers/types'
import { detectRepoFileIcon } from './repo-icon-file-detection'

function sshRoute(
  connectionId: string,
  provider: IFilesystemProvider | null
): ExecutionHostFilesystemRoute {
  return { kind: 'ssh', hostId: `ssh:${connectionId}`, connectionId, provider }
}

// Why: the boundary assertion is "no local read happened", which needs the real
// fs entrypoints spied rather than stubbed.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
})

const WEBP_BASE64 = 'UklGRhoAAABXRUJQVlA4IA4AAAAwAQCdASoBAAEAAQIlSkwAAA=='
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

function remoteFilesystemProvider({
  stat,
  readFile
}: {
  stat: (filePath: string) => Promise<FileStat>
  readFile: (filePath: string) => Promise<FileReadResult>
}): IFilesystemProvider {
  return { stat, readFile } as IFilesystemProvider
}

describe('detectRepoFileIcon remote probing', () => {
  it('detects binary WebP icons through a remote filesystem provider', async () => {
    const provider = remoteFilesystemProvider({
      stat: async (filePath) => {
        if (!filePath.endsWith('/public/icon.webp')) {
          throw new Error('ENOENT')
        }
        return { type: 'file', size: 34, mtime: 0 }
      },
      readFile: async () => ({ content: WEBP_BASE64, isBinary: true, mimeType: 'image/webp' })
    })

    await expect(detectRepoFileIcon('/repo', sshRoute('m4air', provider))).resolves.toEqual({
      type: 'image',
      src: `data:image/webp;base64,${WEBP_BASE64}`,
      source: 'file',
      label: 'public/icon.webp'
    })
  })

  it('keeps conventional-path priority when probes resolve concurrently', async () => {
    const provider = remoteFilesystemProvider({
      stat: async (filePath) => {
        if (filePath.endsWith('/favicon.png') || filePath.endsWith('/public/favicon.png')) {
          return { type: 'file', size: 8, mtime: 0 }
        }
        throw new Error('ENOENT')
      },
      readFile: async (filePath) => {
        if (filePath.endsWith('/favicon.png')) {
          await Promise.resolve()
        }
        return { content: PNG_BASE64, isBinary: true, mimeType: 'image/png' }
      }
    })

    await expect(detectRepoFileIcon('/repo', sshRoute('m4air', provider))).resolves.toMatchObject({
      source: 'file',
      label: 'favicon.png'
    })
  })

  it('bounds concurrent remote probes when no conventional icon exists', async () => {
    let activeStats = 0
    let maxActiveStats = 0
    const stat = vi.fn(async (): Promise<FileStat> => {
      activeStats += 1
      maxActiveStats = Math.max(maxActiveStats, activeStats)
      await Promise.resolve()
      activeStats -= 1
      throw new Error('ENOENT')
    })
    const provider = remoteFilesystemProvider({
      stat,
      readFile: async () => {
        throw new Error('unexpected read')
      }
    })

    await expect(detectRepoFileIcon('/repo', sshRoute('m4air', provider))).resolves.toBeNull()
    expect(maxActiveStats).toBeGreaterThan(1)
    expect(maxActiveStats).toBeLessThanOrEqual(6)
  })
})

describe('detectRepoFileIcon connection boundary', () => {
  it('never reads the client filesystem for a remote repo whose provider is missing', async () => {
    vi.mocked(stat).mockClear()
    vi.mocked(readFile).mockClear()

    await expect(detectRepoFileIcon('/repo', sshRoute('ssh-target-1', null))).resolves.toBeNull()

    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('never reads the client filesystem for a runtime host', async () => {
    // Why: a runtime host's files live on that server. It is not "local with no provider".
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
      detectRepoFileIcon('/repo', { kind: 'local', hostId: 'local' })
    ).resolves.toBeNull()

    expect(stat).toHaveBeenCalled()
  })
})
