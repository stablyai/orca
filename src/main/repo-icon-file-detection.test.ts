import { describe, expect, it, vi } from 'vitest'
import type { FileReadResult, FileStat, IFilesystemProvider } from './providers/types'
import { detectRepoFileIcon } from './repo-icon-file-detection'

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

    await expect(detectRepoFileIcon('/repo', provider)).resolves.toEqual({
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

    await expect(detectRepoFileIcon('/repo', provider)).resolves.toMatchObject({
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

    await expect(detectRepoFileIcon('/repo', provider)).resolves.toBeNull()
    expect(maxActiveStats).toBeGreaterThan(1)
    expect(maxActiveStats).toBeLessThanOrEqual(6)
  })
})
