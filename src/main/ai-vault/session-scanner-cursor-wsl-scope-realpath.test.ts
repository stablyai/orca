import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverLocalCursorSidecarsBounded } from './session-scanner-cursor-local-files'
import { resolveLocalSidecarScopePaths } from './session-scanner-cursor-sources'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WSL Cursor scope realpath resolution', () => {
  it('realpaths the raw UNC path before hashing its resolved Linux cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-wsl-realpath-'))
    roots.push(root)
    const chatsDir = join(root, 'chats')
    const rawUnc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\linked-repo'
    const resolvedUnc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\real-repo'
    const resolvedCwd = '/home/ada/real-repo'
    const bucket = createHash('md5').update(resolvedCwd).digest('hex')
    const metaPath = join(chatsDir, bucket, 'resolved-session', 'meta.json')
    await mkdir(join(chatsDir, bucket, 'resolved-session'), { recursive: true })
    await Promise.all([
      writeFile(metaPath, JSON.stringify({ createdAtMs: 1, updatedAtMs: 2 })),
      writeFile(join(chatsDir, bucket, 'resolved-session', 'store.db'), '')
    ])
    const realpathPath = vi.fn(async (path: string) => {
      expect(path).toBe(rawUnc)
      return resolvedUnc
    })

    const result = await discoverLocalCursorSidecarsBounded({
      chatsDir,
      issues: [],
      pathPlatform: 'linux',
      resolveScopePaths: (scopePath) =>
        resolveLocalSidecarScopePaths({
          realpathPath,
          scopePath,
          storageContextKey: 'wsl:Ubuntu',
          targetPlatform: 'linux'
        }),
      scopePaths: [rawUnc]
    })

    expect(realpathPath).toHaveBeenCalledOnce()
    expect(result.files.map((file) => file.path)).toContain(metaPath)
    expect(result.evidenceByPath.get(metaPath)).toMatchObject({
      bucket,
      cwd: resolvedCwd,
      kind: 'scope-bucket'
    })
  })
})
