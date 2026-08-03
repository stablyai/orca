import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  promoteLocalDownloadedFolder,
  copyLocalDownloadedFileNoClobber,
  publishLocalDownloadedFileNoClobber
} from './local-downloaded-folder-promotion'

describe('promoteLocalDownloadedFolder', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createPaths(): Promise<{
    root: string
    tempPath: string
    destinationPath: string
  }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const tempPath = join(root, '.transfer.download')
    const destinationPath = join(root, 'downloaded')
    await mkdir(join(tempPath, 'nested'), { recursive: true })
    await writeFile(join(tempPath, 'nested', 'file.txt'), 'remote')
    return { root, tempPath, destinationPath }
  }

  it('claims the destination and promotes the completed temporary tree', async () => {
    const { root, tempPath, destinationPath } = await createPaths()

    await promoteLocalDownloadedFolder(tempPath, destinationPath)

    await expect(readFile(join(destinationPath, 'nested', 'file.txt'), 'utf8')).resolves.toBe(
      'remote'
    )
    await expect(readdir(root)).resolves.toEqual(['downloaded'])
  })

  it('does not replace a destination created before publication', async () => {
    const { tempPath, destinationPath } = await createPaths()
    await mkdir(destinationPath)
    await writeFile(join(destinationPath, 'local.txt'), 'local')

    await expect(promoteLocalDownloadedFolder(tempPath, destinationPath)).rejects.toThrow(
      'Destination folder already exists'
    )

    await expect(readFile(join(destinationPath, 'local.txt'), 'utf8')).resolves.toBe('local')
    await expect(readFile(join(tempPath, 'nested', 'file.txt'), 'utf8')).resolves.toBe('remote')
  })

  it('does not replace a file added inside a claimed destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const sourcePath = join(root, 'remote.txt')
    const destinationPath = join(root, 'third-party.txt')
    await writeFile(sourcePath, 'remote')
    await writeFile(destinationPath, 'third-party')

    await expect(
      publishLocalDownloadedFileNoClobber(sourcePath, destinationPath)
    ).rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('remote')
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('third-party')
  })

  it('preserves a mutation made after hard-link state is recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const sourcePath = join(root, 'remote.txt')
    const destinationPath = join(root, 'published.txt')
    await writeFile(sourcePath, 'remote')
    const signal = {
      throwIfAborted: () => {
        writeFileSync(destinationPath, 'third-party mutation')
        throw new Error('window closed')
      }
    } as unknown as AbortSignal

    await expect(
      publishLocalDownloadedFileNoClobber(sourcePath, destinationPath, signal)
    ).rejects.toThrow('window closed')

    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('third-party mutation')
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('third-party mutation')
  })

  it('does not claim a destination after cancellation', async () => {
    const { tempPath, destinationPath } = await createPaths()
    const controller = new AbortController()
    controller.abort(new Error('window closed'))

    await expect(
      promoteLocalDownloadedFolder(tempPath, destinationPath, controller.signal)
    ).rejects.toThrow('window closed')

    await expect(readdir(tempPath)).resolves.toEqual(['nested'])
    await expect(readdir(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back unchanged entries after a mid-publication failure', async () => {
    const { tempPath, destinationPath } = await createPaths()
    await writeFile(join(tempPath, 'a-first.txt'), 'remote')
    await symlink('a-first.txt', join(tempPath, 'z-unsupported-link'))

    await expect(promoteLocalDownloadedFolder(tempPath, destinationPath)).rejects.toThrow(
      "Unexpected local download entry 'z-unsupported-link'"
    )

    await expect(readdir(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a third-party file mutation when later publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const tempPath = join(root, '.transfer.download')
    const destinationPath = join(root, 'downloaded')
    await mkdir(join(tempPath, 'b-work'), { recursive: true })
    await writeFile(join(tempPath, 'a-first.txt'), 'remote')
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeFile(join(tempPath, 'b-work', `${String(index).padStart(3, '0')}.txt`), 'remote')
      )
    )
    await symlink('a-first.txt', join(tempPath, 'z-unsupported-link'))

    const promotion = promoteLocalDownloadedFolder(tempPath, destinationPath)
    const failure = expect(promotion).rejects.toThrow(
      "Unexpected local download entry 'z-unsupported-link'"
    )
    const publishedFile = join(destinationPath, 'a-first.txt')
    for (;;) {
      try {
        await readFile(publishedFile)
        break
      } catch {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    await writeFile(publishedFile, 'third-party mutation')

    await failure
    await expect(readFile(publishedFile, 'utf8')).resolves.toBe('third-party mutation')
  })

  it('cancels between entries and rolls back unchanged published files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const tempPath = join(root, '.transfer.download')
    const destinationPath = join(root, 'downloaded')
    await mkdir(tempPath)
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(join(tempPath, `${String(index).padStart(3, '0')}.txt`), 'remote')
      )
    )
    const controller = new AbortController()

    const promotion = promoteLocalDownloadedFolder(tempPath, destinationPath, controller.signal)
    const failure = expect(promotion).rejects.toThrow('window closed')
    for (;;) {
      try {
        await readFile(join(destinationPath, '000.txt'))
        break
      } catch {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    controller.abort(new Error('window closed'))

    await failure
    await expect(readdir(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels a chunked exclusive-copy fallback and removes its partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-promotion-'))
    roots.push(root)
    const sourcePath = join(root, 'large-source.bin')
    const destinationPath = join(root, 'large-destination.bin')
    const sourceHandle = await open(sourcePath, 'wx')
    await sourceHandle.truncate(64 * 1024 * 1024)
    await sourceHandle.close()
    const controller = new AbortController()

    const copying = copyLocalDownloadedFileNoClobber(sourcePath, destinationPath, controller.signal)
    const failure = expect(copying).rejects.toThrow('copy canceled')
    for (;;) {
      try {
        await lstat(destinationPath)
        break
      } catch {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    controller.abort(new Error('copy canceled'))

    await failure
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(sourcePath)).resolves.toMatchObject({ size: 64 * 1024 * 1024 })
  })
})
