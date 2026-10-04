import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WslTranscriptFsProcessOperations } from './wsl-transcript-fs-process-operations'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('WSL transcript filesystem process operations', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a symlink only for an opted-in regular-file open',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-regular-'))
      temporaryDirectories.push(directory)
      const path = join(directory, 'events.frames')
      const target = join(directory, 'target.frames')
      await writeFile(target, 'native transcript bytes')
      await symlink(target, path)
      const operations = new WslTranscriptFsProcessOperations()
      await expect(
        operations.execute({ id: 1, operation: 'open', path, regularFile: true })
      ).rejects.toThrow('regular file')
      const handleId = await operations.execute({ id: 2, operation: 'open', path })
      if (typeof handleId !== 'number') {
        throw new Error('Invalid process-owned handle')
      }
      try {
        await expect(
          operations.execute({ id: 3, operation: 'read', handleId, position: 0, length: 64 })
        ).resolves.toEqual(Buffer.from('native transcript bytes'))
      } finally {
        await operations.execute({ id: 4, operation: 'close', handleId })
      }
    }
  )

  // Local NTFS rejects replacing an open file; WSL/9P follows Linux rename semantics.
  it.skipIf(process.platform === 'win32')(
    'keeps positional reads on the opened inode after atomic path replacement',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-transcript-'))
      temporaryDirectories.push(directory)
      const transcriptPath = join(directory, 'session.jsonl')
      const replacementPath = join(directory, 'replacement.jsonl')
      await writeFile(transcriptPath, 'original transcript')
      await writeFile(replacementPath, 'replacement bytes')
      const operations = new WslTranscriptFsProcessOperations()

      const handleId = (await operations.execute({
        id: 1,
        operation: 'open',
        path: transcriptPath
      })) as number
      await rename(replacementPath, transcriptPath)
      const body = await operations.execute({
        id: 2,
        operation: 'read',
        handleId,
        position: 0,
        length: 64
      })
      await operations.execute({ id: 3, operation: 'close', handleId })

      expect(Buffer.from(body as Buffer).toString('utf8')).toBe('original transcript')
    }
  )
})
