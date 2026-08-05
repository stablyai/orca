import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorBucketForCwd } from './session-scanner-cursor-paths'
import {
  parseCursorSidecarFileCached,
  resetCursorSidecarParseCacheForTests
} from './session-scanner-cursor-sidecar'

const roots: string[] = []

afterEach(async () => {
  resetCursorSidecarParseCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Cursor sidecar parse cache isolation', () => {
  it('does not reuse host-stamped issues across execution hosts', async () => {
    const fixture = await createSidecar()
    const first = await parseCursorSidecarFileCached({
      ...fixture,
      executionHostId: 'ssh:first'
    })
    const second = await parseCursorSidecarFileCached({
      ...fixture,
      executionHostId: 'runtime:second'
    })

    expect(first.issue?.executionHostId).toBe('ssh:first')
    expect(second.issue?.executionHostId).toBe('runtime:second')
  })

  it('revalidates the file when the expected root changes', async () => {
    const fixture = await createSidecar()
    await parseCursorSidecarFileCached(fixture)
    const unrelatedRoot = await mkdtemp(join(tmpdir(), 'orca-cursor-unrelated-'))
    roots.push(unrelatedRoot)

    await expect(
      parseCursorSidecarFileCached({
        ...fixture,
        expectedRootRealPath: await realpath(unrelatedRoot)
      })
    ).rejects.toThrow('verified_file_outside_root')
  })
})

async function createSidecar() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-cache-'))
  roots.push(root)
  const chatsRoot = join(root, 'chats')
  const bucket = cursorBucketForCwd('/correct', process.platform)
  const sessionDir = join(chatsRoot, bucket, 'session')
  const metaPath = join(sessionDir, 'meta.json')
  const storePath = join(sessionDir, 'store.db')
  await mkdir(sessionDir, { recursive: true })
  await Promise.all([
    writeFile(
      metaPath,
      JSON.stringify({ createdAtMs: 10, updatedAtMs: 20, hasConversation: true, cwd: '/wrong' })
    ),
    writeFile(storePath, '')
  ])
  const [meta, store, expectedRootRealPath] = await Promise.all([
    lstat(metaPath),
    lstat(storePath),
    realpath(chatsRoot)
  ])
  return {
    file: {
      path: metaPath,
      mtimeMs: meta.mtimeMs,
      modifiedAt: meta.mtime.toISOString(),
      sizeBytes: meta.size,
      cursorStoreMtimeMs: store.mtimeMs,
      dev: meta.dev,
      ino: meta.ino,
      nlink: meta.nlink
    },
    platform: process.platform,
    expectedRootRealPath
  }
}
