import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVerifiedTerminalArtifactChunk } from './fs-handler-terminal-artifact'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verified relay terminal artifact chunks', () => {
  it('reads only the requested range through the canonical exact-path handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-chunk-'))
    roots.push(root)
    const filePath = join(root, 'result.bin')
    await writeFile(filePath, Buffer.from([0, 1, 2, 3, 255]))

    await expect(
      readVerifiedTerminalArtifactChunk({
        filePath,
        expectedRealPath: await realpath(filePath),
        expectedStatIdentity: null,
        maxBytes: 5,
        offset: 2,
        length: 2
      })
    ).resolves.toEqual({
      contentBase64: Buffer.from([2, 3]).toString('base64'),
      bytesRead: 2,
      eof: false
    })
  })

  it('rejects files above the caller bound before allocating a chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-chunk-'))
    roots.push(root)
    const filePath = join(root, 'result.bin')
    await writeFile(filePath, Buffer.alloc(5))

    await expect(
      readVerifiedTerminalArtifactChunk({
        filePath,
        expectedRealPath: await realpath(filePath),
        maxBytes: 4,
        offset: 0,
        length: 4
      })
    ).rejects.toThrow('file_too_large')
  })

  it('rejects a path retargeted after grant creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-chunk-'))
    roots.push(root)
    const grantedPath = join(root, 'granted.bin')
    const outsidePath = join(root, 'outside.bin')
    await writeFile(grantedPath, 'granted')
    await writeFile(outsidePath, 'outside')
    const expectedRealPath = await realpath(grantedPath)
    await rm(grantedPath)
    await symlink(outsidePath, grantedPath)

    await expect(
      readVerifiedTerminalArtifactChunk({
        filePath: grantedPath,
        expectedRealPath,
        maxBytes: 16,
        offset: 0,
        length: 16
      })
    ).rejects.toThrow('terminal_file_grant_stale')
  })
})
