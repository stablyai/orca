import { describe, expect, it, vi } from 'vitest'
import type { Dir, Dirent } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { homedirMock, opendirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  opendirMock: vi.fn<(dirPath: string) => Promise<Dir>>()
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    opendir: opendirMock
  }
})

const FILE_COUNT = 125_000
const FAKE_HOME = join('/', 'tmp', 'orca-large-claude-home')
const PROJECTS_ROOT = join(FAKE_HOME, '.claude', 'projects')
const TRANSCRIPTS_ROOT = join(FAKE_HOME, '.claude', 'transcripts')
const PROJECT_DIR = join(PROJECTS_ROOT, 'large-project')

function dirent(name: string, kind: 'directory' | 'file'): Dirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file'
  } as Dirent
}

const largeTranscriptEntries = Array.from({ length: FILE_COUNT }, (_, index) =>
  dirent(`session-${index}.jsonl`, 'file')
)

function directory(entries: Dirent[]): Dir {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries
    }
  } as Dir
}

function generatedFileDirectory(count: number): Dir {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < count; index++) {
        yield dirent(`session-${index}.jsonl`, 'file')
      }
    }
  } as Dir
}

describe('listClaudeTranscriptFiles large directories', () => {
  it('keeps nested transcript scans past the JavaScript spread-argument limit', async () => {
    homedirMock.mockReturnValue(FAKE_HOME)
    opendirMock.mockImplementation(async (dirPath) => {
      if (dirPath === PROJECTS_ROOT) {
        return directory([dirent('large-project', 'directory')])
      }
      if (dirPath === PROJECT_DIR) {
        return directory(largeTranscriptEntries)
      }
      if (dirPath === TRANSCRIPTS_ROOT) {
        return directory([])
      }
      throw new Error(`Unexpected opendir path: ${dirPath}`)
    })

    const { listClaudeTranscriptFiles } = await import('./scanner')

    await expect(listClaudeTranscriptFiles()).resolves.toHaveLength(FILE_COUNT)
  })

  it('fails closed instead of silently omitting a transcript past capacity', async () => {
    opendirMock.mockImplementation(async (dirPath) => {
      if (dirPath === PROJECTS_ROOT) {
        return generatedFileDirectory(200_001)
      }
      if (dirPath === TRANSCRIPTS_ROOT) {
        return directory([])
      }
      throw new Error(`Unexpected opendir path: ${dirPath}`)
    })

    const { listClaudeTranscriptFiles } = await import('./scanner')

    await expect(listClaudeTranscriptFiles()).rejects.toMatchObject({
      name: 'UsageHistoryScanCapacityError',
      resource: 'files',
      limit: 200_000
    })
  })

  it('keeps stable transcripts when a nested directory vanishes during discovery', async () => {
    const vanishedDirectory = join(PROJECTS_ROOT, 'vanished')
    opendirMock.mockImplementation(async (dirPath) => {
      if (dirPath === PROJECTS_ROOT) {
        return directory([dirent('stable.jsonl', 'file'), dirent('vanished', 'directory')])
      }
      if (dirPath === vanishedDirectory) {
        throw Object.assign(new Error('directory vanished'), { code: 'ENOENT' })
      }
      if (dirPath === TRANSCRIPTS_ROOT) {
        return directory([])
      }
      throw new Error(`Unexpected opendir path: ${dirPath}`)
    })

    const { listClaudeTranscriptFiles } = await import('./scanner')

    await expect(listClaudeTranscriptFiles()).resolves.toEqual([
      join(PROJECTS_ROOT, 'stable.jsonl')
    ])
  })
})
