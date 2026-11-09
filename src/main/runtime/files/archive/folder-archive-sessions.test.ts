import { mkdtemp, mkdir, rename, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderArchiveSessions } from './folder-archive-sessions'
import {
  FolderArchiveLimitError,
  planFolderArchive,
  sanitizeArchiveSegment
} from './folder-archive-walk'
import { FolderArchiveZipStream } from './folder-archive-zip-stream'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-archive-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function drain(sessions: FolderArchiveSessions, archiveId: string, ownerKey = 'device-a') {
  const parts: Buffer[] = []
  for (;;) {
    const page = await sessions.read({ archiveId, ownerKey, maxBytes: 64 * 1024 })
    parts.push(Buffer.from(page.contentBase64, 'base64'))
    if (page.eof) {
      return { bytes: Buffer.concat(parts), last: page }
    }
  }
}

describe('FolderArchiveSessions', () => {
  it('zips a folder with nested files, empty dirs and the default exclusions applied', async () => {
    const project = join(root, 'project')
    await mkdir(join(project, 'src', 'empty'), { recursive: true })
    await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'src', 'a.txt'), 'hello')
    await writeFile(join(project, 'run.sh'), '#!/bin/sh\n')
    await chmod(join(project, 'run.sh'), 0o755)
    await writeFile(join(project, 'node_modules', 'pkg', 'index.js'), 'x')
    await writeFile(join(project, '.git', 'HEAD'), 'ref')
    const sessions = new FolderArchiveSessions()

    const started = await sessions.start({
      folderPath: project,
      ownerKey: 'device-a',
      excludeDefaultDirs: true
    })
    expect(started).toMatchObject({
      suggestedName: 'project.zip',
      fileCount: 2,
      totalBytes: 15,
      excludedDirCount: 2
    })
    const { bytes, last } = await drain(sessions, started.archiveId)
    expect(last.processedBytes).toBe(15)
    const files = unzipSync(bytes)
    expect(Object.keys(files).sort()).toEqual([
      'project/',
      'project/run.sh',
      'project/src/',
      'project/src/a.txt',
      'project/src/empty/'
    ])
    expect(Buffer.from(files['project/src/a.txt']).toString()).toBe('hello')
    expect(sessions.activeCount()).toBe(0)
  })

  it('includes dependency folders when exclusion is off', async () => {
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x.js'), 'x')
    const plan = await planFolderArchive(root, 'r', { excludeDefaultDirs: false })
    expect(plan.entries.map((entry) => entry.archivePath)).toContain('r/node_modules/x.js')
  })

  it('stores symlinks as links and never reads what they point at', async () => {
    const outside = join(root, 'outside-secret.txt')
    await writeFile(outside, 'secret')
    const project = join(root, 'p')
    await mkdir(project)
    await symlink(outside, join(project, 'link'))
    await symlink(root, join(project, 'dir-link'))
    const plan = await planFolderArchive(project, 'p', { excludeDefaultDirs: true })
    expect(plan.totalBytes).toBe(0)
    const stream = new FolderArchiveZipStream(plan.entries)
    const parts: Buffer[] = []
    for (;;) {
      const page = await stream.read(1 << 20)
      parts.push(page.bytes)
      if (page.eof) {
        break
      }
    }
    const files = unzipSync(Buffer.concat(parts))
    expect(Buffer.from(files['p/link']).toString()).toBe(outside)
    expect(Object.keys(files).some((name) => name.includes('outside-secret'))).toBe(false)
    expect(Object.keys(files)).not.toContain('p/dir-link/')
  })

  it('skips a file whose parent directory was swapped for a link after the walk', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'a.txt'), 'secret')
    const project = join(root, 'p')
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'sub', 'a.txt'), 'inside')
    const plan = await planFolderArchive(project, 'p', { excludeDefaultDirs: true })
    // Same name, different file: O_NOFOLLOW alone would follow the swapped parent.
    await rename(join(project, 'sub'), join(root, 'moved'))
    await symlink(outside, join(project, 'sub'))
    const stream = new FolderArchiveZipStream(plan.entries)
    const parts: Buffer[] = []
    for (;;) {
      const page = await stream.read(1 << 20)
      parts.push(page.bytes)
      if (page.eof) {
        break
      }
    }
    const files = unzipSync(Buffer.concat(parts))
    expect(files['p/sub/a.txt']).toBeUndefined()
    expect(stream.skippedCount).toBe(1)
  })

  it('rewrites backslashes and control characters so Windows extractors cannot escape', () => {
    expect(sanitizeArchiveSegment('..\\..\\evil')).toBe('.._.._evil')
    expect(sanitizeArchiveSegment('a\u0001b')).toBe('a_b')
    expect(sanitizeArchiveSegment('..')).toBe('_')
    expect(sanitizeArchiveSegment('normal name.txt')).toBe('normal name.txt')
  })

  it('refuses folders over the byte or entry limits', async () => {
    await writeFile(join(root, 'a'), Buffer.alloc(10))
    await writeFile(join(root, 'b'), Buffer.alloc(10))
    await expect(
      planFolderArchive(root, 'r', { excludeDefaultDirs: true, maxTotalBytes: 15 })
    ).rejects.toEqual(new FolderArchiveLimitError('archive_too_large'))
    await expect(
      planFolderArchive(root, 'r', { excludeDefaultDirs: true, maxEntries: 2 })
    ).rejects.toEqual(new FolderArchiveLimitError('archive_too_many_entries'))
  })

  it('refuses to archive a file', async () => {
    await writeFile(join(root, 'f'), 'x')
    const sessions = new FolderArchiveSessions()
    await expect(
      sessions.start({ folderPath: join(root, 'f'), ownerKey: 'a', excludeDefaultDirs: true })
    ).rejects.toThrow('archive_not_directory')
  })

  it('hides an archive from other devices and frees it on cancel', async () => {
    await writeFile(join(root, 'f'), 'x')
    const sessions = new FolderArchiveSessions()
    const { archiveId } = await sessions.start({
      folderPath: root,
      ownerKey: 'device-a',
      excludeDefaultDirs: true
    })
    await expect(sessions.read({ archiveId, ownerKey: 'device-b', maxBytes: 10 })).rejects.toThrow(
      'archive_not_found'
    )
    expect(sessions.cancel({ archiveId, ownerKey: 'device-b' })).toBe(false)
    expect(sessions.cancel({ archiveId, ownerKey: 'device-a' })).toBe(true)
    expect(sessions.activeCount()).toBe(0)
    await expect(sessions.read({ archiveId, ownerKey: 'device-a', maxBytes: 10 })).rejects.toThrow(
      'archive_not_found'
    )
  })

  it('caps concurrent archives and releases idle ones', async () => {
    const sessions = new FolderArchiveSessions(20, 1)
    const first = await sessions.start({
      folderPath: root,
      ownerKey: 'a',
      excludeDefaultDirs: true
    })
    await expect(
      sessions.start({ folderPath: root, ownerKey: 'a', excludeDefaultDirs: true })
    ).rejects.toThrow('archive_busy')
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0))
    await expect(
      sessions.read({ archiveId: first.archiveId, ownerKey: 'a', maxBytes: 10 })
    ).rejects.toThrow('archive_not_found')
  })

  it('pauses the producer at the high-water mark until the reader drains', async () => {
    await writeFile(join(root, 'big.png'), Buffer.alloc(4 * 1024 * 1024, 7))
    const plan = await planFolderArchive(root, 'r', { excludeDefaultDirs: true })
    const stream = new FolderArchiveZipStream(plan.entries, 512 * 1024)
    // The producer fills to the mark, then must stop until something is read.
    await vi.waitFor(() => expect(stream.processedBytes).toBeGreaterThanOrEqual(512 * 1024))
    expect(stream.processedBytes).toBeLessThanOrEqual(1024 * 1024)
    let total = 0
    for (;;) {
      const page = await stream.read(256 * 1024)
      total += page.bytes.byteLength
      if (page.eof) {
        break
      }
    }
    expect(stream.processedBytes).toBe(4 * 1024 * 1024)
    expect(total).toBeGreaterThan(4 * 1024 * 1024)
  })
})
