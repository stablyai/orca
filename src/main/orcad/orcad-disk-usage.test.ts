import { describe, expect, it, vi } from 'vitest'
import { readOrcadDiskUsage, type DiskUsageFs } from './orcad-disk-usage'

const GIB = 1024 ** 3

function fakeFs(
  mounts: Record<string, { dev: number; blocks: number; bfree: number; bavail: number }>
): DiskUsageFs & { statfsCalls: string[] } {
  const statfsCalls: string[] = []
  return {
    statfsCalls,
    stat: vi.fn(async (path: string) => {
      const mount = mounts[path]
      if (!mount) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { dev: mount.dev }
    }),
    statfs: vi.fn(async (path: string) => {
      statfsCalls.push(path)
      const mount = mounts[path]!
      return { bsize: 4096, blocks: mount.blocks, bfree: mount.bfree, bavail: mount.bavail }
    })
  }
}

const blocks = (bytes: number): number => bytes / 4096

describe('readOrcadDiskUsage', () => {
  it('reports total, free, available and df-style used percent', async () => {
    const fs = fakeFs({
      '/vercel/sandbox': {
        dev: 1,
        blocks: blocks(32 * GIB),
        bfree: blocks(2 * GIB),
        bavail: blocks(1 * GIB)
      }
    })
    const result = await readOrcadDiskUsage(['/vercel/sandbox'], { fs, now: () => 42 })
    expect(result).toEqual({
      checkedAt: 42,
      volumes: [
        {
          path: '/vercel/sandbox',
          totalBytes: 32 * GIB,
          freeBytes: 2 * GIB,
          availableBytes: 1 * GIB,
          // used 30 / (used 30 + avail 1)
          usedPercent: (30 / 31) * 100
        }
      ]
    })
  })

  it('folds paths on one filesystem into one volume and keeps a distinct home', async () => {
    const fs = fakeFs({
      '/vercel/sandbox': { dev: 1, blocks: 100, bfree: 50, bavail: 50 },
      '/vercel/sandbox/repo': { dev: 1, blocks: 100, bfree: 50, bavail: 50 },
      '/home/user': { dev: 2, blocks: 200, bfree: 10, bavail: 10 }
    })
    const result = await readOrcadDiskUsage(
      ['/vercel/sandbox', '/vercel/sandbox/repo', '/vercel/sandbox', '/home/user'],
      { fs }
    )
    expect(result.volumes.map((v) => v.path)).toEqual(['/vercel/sandbox', '/home/user'])
    expect(fs.statfsCalls).toEqual(['/vercel/sandbox', '/home/user'])
  })

  it('measures a missing workspace dir at its nearest existing ancestor', async () => {
    const fs = fakeFs({ '/home/user': { dev: 2, blocks: 100, bfree: 90, bavail: 90 } })
    const result = await readOrcadDiskUsage(['/home/user/orca/workspaces'], { fs })
    expect(result.volumes.map((v) => v.path)).toEqual(['/home/user'])
  })

  it('skips paths whose statfs fails without failing the probe', async () => {
    const fs = fakeFs({
      '/a': { dev: 1, blocks: 100, bfree: 1, bavail: 1 },
      '/b': { dev: 2, blocks: 100, bfree: 1, bavail: 1 }
    })
    fs.statfs = vi.fn(async (path: string) => {
      if (path === '/a') {
        throw new Error('EACCES')
      }
      return { bsize: 4096, blocks: 100, bfree: 1, bavail: 1 }
    })
    const result = await readOrcadDiskUsage(['/a', '/b', null, undefined, ''], { fs })
    expect(result.volumes.map((v) => v.path)).toEqual(['/b'])
  })

  it('reads 0% used for an empty filesystem rather than dividing by zero', async () => {
    const fs = fakeFs({ '/': { dev: 1, blocks: 0, bfree: 0, bavail: 0 } })
    const result = await readOrcadDiskUsage(['/'], { fs })
    expect(result.volumes[0]!.usedPercent).toBe(0)
  })

  it('statfs-es the real filesystem by default', async () => {
    const result = await readOrcadDiskUsage([process.cwd()])
    expect(result.volumes).toHaveLength(1)
    expect(result.volumes[0]!.totalBytes).toBeGreaterThan(0)
  })
})
