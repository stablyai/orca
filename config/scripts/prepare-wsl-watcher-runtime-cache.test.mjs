import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { downloadRuntime, WSL_WATCHER_NODE_VERSION } from './prepare-wsl-watcher-runtime.mjs'

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function successfulFetch(contents) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from(contents).buffer
  }))
}

function cachedArchive(cacheDir) {
  return join(cacheDir, `node-v${WSL_WATCHER_NODE_VERSION}-linux-x64.tar.xz`)
}

async function cacheArtifacts(cacheDir) {
  return (await readdir(cacheDir)).sort()
}

describe('managed WSL runtime archive cache', () => {
  it('cleans a partial unique temp and preserves cache when writing fails', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'orca-wsl-cache-write-'))
    const cached = cachedArchive(cacheDir)
    const next = Buffer.from('verified next archive')
    try {
      await writeFile(cached, 'previous cache')
      await expect(
        downloadRuntime('x64', sha256(next), {
          runtimeCacheDir: cacheDir,
          fetchRuntime: successfulFetch(next),
          createPublicationId: () => 'write-failure',
          runtimeFileOperations: {
            writeFile: async (filename, contents) => {
              await writeFile(filename, contents)
              if (filename.endsWith('.stage-write-failure')) {
                throw new Error('cache write failed')
              }
            }
          }
        })
      ).rejects.toThrow('cache write failed')

      await expect(readFile(cached, 'utf8')).resolves.toBe('previous cache')
      await expect(cacheArtifacts(cacheDir)).resolves.toEqual([cached.split(/[\\/]/).at(-1)])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('rolls cache publication back and cleans temp files when rename fails', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'orca-wsl-cache-rename-'))
    const cached = cachedArchive(cacheDir)
    const next = Buffer.from('verified next archive')
    const temporary = `${cached}.stage-rename-failure`
    try {
      await writeFile(cached, 'previous cache')
      await expect(
        downloadRuntime('x64', sha256(next), {
          runtimeCacheDir: cacheDir,
          fetchRuntime: successfulFetch(next),
          createPublicationId: () => 'rename-failure',
          runtimeFileOperations: {
            rename: async (from, to) => {
              if (from === temporary && to === cached) {
                throw new Error('cache rename failed')
              }
              return rename(from, to)
            }
          }
        })
      ).rejects.toThrow('cache rename failed')

      await expect(readFile(cached, 'utf8')).resolves.toBe('previous cache')
      await expect(cacheArtifacts(cacheDir)).resolves.toEqual([cached.split(/[\\/]/).at(-1)])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('keeps a concurrently published verified archive instead of replacing it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'orca-wsl-cache-race-'))
    const cached = cachedArchive(cacheDir)
    const next = Buffer.from('verified next archive')
    const renameRuntimePath = vi.fn(rename)
    try {
      await writeFile(cached, 'stale cache')
      await downloadRuntime('x64', sha256(next), {
        runtimeCacheDir: cacheDir,
        fetchRuntime: successfulFetch(next),
        createPublicationId: () => 'racing',
        beforeCachePublish: async () => writeFile(cached, next),
        runtimeFileOperations: { rename: renameRuntimePath }
      })

      expect(
        renameRuntimePath.mock.calls.some(
          ([from, to]) => String(from).includes('.stage-') && to === cached
        )
      ).toBe(false)
      await expect(readFile(cached)).resolves.toEqual(next)
      await expect(cacheArtifacts(cacheDir)).resolves.toEqual([cached.split(/[\\/]/).at(-1)])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('recovers a verified crash backup before downloading and scavenges aged stages', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'orca-wsl-cache-recover-'))
    const cached = cachedArchive(cacheDir)
    const backup = `${cached}.backup-crash`
    const staleStage = `${cached}.stage-abandoned`
    const verified = Buffer.from('verified crash backup')
    const fetchRuntime = successfulFetch(Buffer.from('should not download'))
    try {
      await writeFile(backup, verified)
      await writeFile(staleStage, 'partial')
      await utimes(staleStage, new Date(0), new Date(0))

      await downloadRuntime('x64', sha256(verified), {
        runtimeCacheDir: cacheDir,
        fetchRuntime,
        createPublicationId: () => 'recovered'
      })

      expect(fetchRuntime).not.toHaveBeenCalled()
      await expect(readFile(cached)).resolves.toEqual(verified)
      await expect(cacheArtifacts(cacheDir)).resolves.toEqual([cached.split(/[\\/]/).at(-1)])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
