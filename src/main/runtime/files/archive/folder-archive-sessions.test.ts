import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile, chmod } from 'node:fs/promises'
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
import { FolderArchiveZipStream, isContainedLinkTarget } from './folder-archive-zip-stream'

let root: string

beforeEach(async () => {
  // Canonical, as the RPC hands it over (macOS tmpdir sits behind /var -> /private/var).
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-archive-test-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function zipEntries(stream: FolderArchiveZipStream) {
  const parts: Buffer[] = []
  for (;;) {
    const page = await stream.read(1 << 20)
    parts.push(page.bytes)
    if (page.eof) {
      return unzipSync(Buffer.concat(parts))
    }
  }
}

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

  it('keeps links that stay inside the folder and drops ones that point out of it', async () => {
    const outside = join(root, 'outside-secret.txt')
    await writeFile(outside, 'secret')
    const project = join(root, 'p')
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'target.txt'), 'in')
    await symlink(outside, join(project, 'abs-link'))
    await symlink('../outside-secret.txt', join(project, 'rel-escape'))
    await symlink(root, join(project, 'dir-link'))
    await symlink('../target.txt', join(project, 'sub', 'inner-link'))
    const plan = await planFolderArchive(project, 'p', { excludeDefaultDirs: true })
    const stream = new FolderArchiveZipStream(plan.entries, plan.rootRealPath)
    const files = await zipEntries(stream)
    expect(Buffer.from(files['p/sub/inner-link']).toString()).toBe('../target.txt')
    for (const dropped of ['p/abs-link', 'p/rel-escape', 'p/dir-link', 'p/dir-link/']) {
      expect(files[dropped]).toBeUndefined()
    }
    expect(Object.keys(files).some((name) => name.includes('outside-secret'))).toBe(false)
    expect(stream.skippedCount).toBe(3)
  })

  it('judges link targets against the archive root', () => {
    expect(isContainedLinkTarget('p/a/l', '../b')).toBe(true)
    expect(isContainedLinkTarget('p/a/l', '../../x')).toBe(false)
    expect(isContainedLinkTarget('p/l', '/etc/passwd')).toBe(false)
    expect(isContainedLinkTarget('p/l', 'C:x')).toBe(false)
    expect(isContainedLinkTarget('p/a/b/l', 's/../../..')).toBe(false)
    expect(isContainedLinkTarget('p/l', '..\\x')).toBe(false)
  })

  it('skips a file moved out of the folder and linked back in after the walk', async () => {
    const project = join(root, 'p')
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'sub', 'a.txt'), 'moved-out')
    const plan = await planFolderArchive(project, 'p', { excludeDefaultDirs: true })
    // Same dev/ino as the walk saw, but now outside the root.
    await rename(join(project, 'sub'), join(root, 'moved'))
    await symlink(join(root, 'moved'), join(project, 'sub'))
    const stream = new FolderArchiveZipStream(plan.entries, plan.rootRealPath)
    const files = await zipEntries(stream)
    expect(files['p/sub/a.txt']).toBeUndefined()
    expect(stream.skippedCount).toBe(1)
  })

  it('never reads past the walked size of a file that grew', async () => {
    await writeFile(join(root, 'log.bin'), Buffer.alloc(100 * 1024, 1))
    const plan = await planFolderArchive(root, 'r', { excludeDefaultDirs: true })
    await writeFile(join(root, 'log.bin'), Buffer.alloc(900 * 1024, 1), { flag: 'a' })
    const files = await zipEntries(new FolderArchiveZipStream(plan.entries, plan.rootRealPath))
    expect(files['r/log.bin'].byteLength).toBe(100 * 1024)
  })

  it('gives case- and Unicode-folded twins distinct names', async () => {
    await writeFile(join(root, 'Read.md'), 'a')
    await writeFile(join(root, 'read.md'), 'b')
    const plan = await planFolderArchive(root, 'r', { excludeDefaultDirs: true })
    const names = plan.entries.map((entry) => entry.archivePath).filter((p) => p.endsWith('.md'))
    // macOS temp dirs fold case themselves; then there is only one file to name.
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length)
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
    const stream = new FolderArchiveZipStream(plan.entries, plan.rootRealPath)
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
    expect(sanitizeArchiveSegment('..')).toBe('__')
    expect(sanitizeArchiveSegment('CON')).toBe('_CON')
    expect(sanitizeArchiveSegment('aux.txt')).toBe('_aux.txt')
    expect(sanitizeArchiveSegment('a:b*c?.txt')).toBe('a_b_c_.txt')
    expect(sanitizeArchiveSegment('notes. ')).toBe('notes__')
    expect(sanitizeArchiveSegment('normal name.txt')).toBe('normal name.txt')
    expect(sanitizeArchiveSegment('invoice\u202Etxt.exe')).toBe('invoicetxt.exe')
    expect(sanitizeArchiveSegment('\u200B')).toBe('_')
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

  it('refuses a folder that was swapped for a link after it was authorized', async () => {
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'swapped'))
    await expect(
      planFolderArchive(join(root, 'swapped'), 's', { excludeDefaultDirs: true })
    ).rejects.toThrow('archive_not_directory')
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

  it('limits archives per client so one client cannot hold every slot', async () => {
    const sessions = new FolderArchiveSessions(60_000, 8, 2)
    const start = (ownerKey: string) =>
      sessions.start({ folderPath: root, ownerKey, excludeDefaultDirs: true })
    // Concurrent starts reserve their slot before walking.
    const results = await Promise.allSettled([start('a'), start('a'), start('a')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    await expect(start('b')).resolves.toMatchObject({ suggestedName: expect.any(String) })
  })

  it('pauses the producer at the high-water mark until the reader drains', async () => {
    await writeFile(join(root, 'big.png'), Buffer.alloc(4 * 1024 * 1024, 7))
    const plan = await planFolderArchive(root, 'r', { excludeDefaultDirs: true })
    const stream = new FolderArchiveZipStream(plan.entries, plan.rootRealPath, 512 * 1024)
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
