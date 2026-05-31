import { describe, expect, it, vi } from 'vitest'
import type { Dirent } from 'node:fs'
import type * as FsPromises from 'fs/promises'
import type * as NodeOs from 'os'
import { join } from 'path'

const { homedirMock, readdirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  readdirMock: vi.fn<(dirPath: string) => Promise<Dirent[]>>()
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
    readdir: readdirMock
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

describe('listClaudeTranscriptFiles large directories', () => {
  it('keeps nested transcript scans past the JavaScript spread-argument limit', async () => {
    homedirMock.mockReturnValue(FAKE_HOME)
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === PROJECTS_ROOT) {
        return [dirent('large-project', 'directory')]
      }
      if (dirPath === PROJECT_DIR) {
        return largeTranscriptEntries
      }
      if (dirPath === TRANSCRIPTS_ROOT) {
        return []
      }
      throw new Error(`Unexpected readdir path: ${dirPath}`)
    })

    const { listClaudeTranscriptFiles } = await import('./scanner')

    await expect(listClaudeTranscriptFiles()).resolves.toHaveLength(FILE_COUNT)
  })
})
