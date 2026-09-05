import { Readable } from 'node:stream'
import type { Dirent } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock, readdirMock, wslReaddirMock, wslStatMock, wslStreamMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  readdirMock: vi.fn<(path: string) => Promise<Dirent[]>>(),
  wslReaddirMock: vi.fn<(path: string, priority: string) => Promise<Dirent[]>>(),
  wslStatMock:
    vi.fn<(path: string, priority: string) => Promise<{ mtimeMs: number; size: number }>>(),
  wslStreamMock: vi.fn<(path: string, options: object, priority: string) => Readable>()
}))

vi.mock('os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('os')),
  homedir: homedirMock
}))

vi.mock('fs/promises', async () => ({
  ...(await vi.importActual<typeof FsPromises>('fs/promises')),
  readdir: readdirMock
}))

vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn()
}))

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  openTranscriptReadStream: wslStreamMock,
  wslGatedReaddir: wslReaddirMock,
  wslGatedStat: wslStatMock
}))

const WSL_HOME = String.raw`\\wsl.localhost\Ubuntu\home\ada`
const WSL_PROJECTS = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects`
const WSL_TRANSCRIPTS = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\transcripts`
const WSL_PROJECT = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects\repo`
const WSL_FILE = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude\projects\repo\session.jsonl`
const WSL_ALT_CONFIG = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt`
const WSL_ALT_PROJECTS = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt\projects`
const WSL_ALT_PROJECT = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt\projects\repo`
const WSL_ALT_FILE = String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-alt\projects\repo\session.jsonl`
const NATIVE_CONFIG = String.raw`C:\Users\ada\.claude`

function dirent(name: string, kind: 'directory' | 'file'): Dirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file'
  } as Dirent
}

beforeEach(() => {
  homedirMock.mockReturnValue('/tmp/orca-claude-home')
  readdirMock.mockResolvedValue([])
  wslReaddirMock.mockResolvedValue([])
  wslStatMock.mockResolvedValue({ mtimeMs: 123, size: 10 })
  wslStreamMock.mockReturnValue(Readable.from([]))
  vi.resetModules()
})

describe('Claude usage transcript discovery on Windows', () => {
  it('includes Claude projects and transcripts from WSL homes', async () => {
    wslReaddirMock.mockImplementation(async (path) => {
      if (path === WSL_PROJECTS) {
        return [dirent('repo', 'directory')]
      }
      if (path === WSL_PROJECT) {
        return [dirent('session.jsonl', 'file')]
      }
      if (path === WSL_TRANSCRIPTS) {
        return []
      }
      throw new Error(`unexpected WSL path: ${path}`)
    })

    const { listClaudeTranscriptFiles } = await import('./transcript-file-discovery')
    await expect(
      listClaudeTranscriptFiles({
        platform: 'win32',
        listWslHomeDirs: async () => [WSL_HOME]
      })
    ).resolves.toEqual([WSL_FILE])
    expect(wslReaddirMock).toHaveBeenCalledWith(WSL_PROJECTS, 'scan')
  })

  it('scans only the selected config directory instead of aggregating WSL homes', async () => {
    wslReaddirMock.mockImplementation(async (path) => {
      if (path === WSL_ALT_PROJECTS) {
        return [dirent('repo', 'directory')]
      }
      if (path === WSL_ALT_PROJECT) {
        return [dirent('session.jsonl', 'file')]
      }
      throw new Error(`unexpected WSL path: ${path}`)
    })

    const { listClaudeTranscriptFiles } = await import('./transcript-file-discovery')
    await expect(
      listClaudeTranscriptFiles({ platform: 'win32', configDir: WSL_ALT_CONFIG })
    ).resolves.toEqual([WSL_ALT_FILE])
  })

  it('keeps WSL home discovery for the native Windows config directory', async () => {
    wslReaddirMock.mockImplementation(async (path) => {
      if (path === WSL_PROJECTS) {
        return [dirent('repo', 'directory')]
      }
      if (path === WSL_PROJECT) {
        return [dirent('session.jsonl', 'file')]
      }
      if (path === WSL_TRANSCRIPTS) {
        return []
      }
      throw new Error(`unexpected WSL path: ${path}`)
    })

    const { listClaudeTranscriptFiles } = await import('./transcript-file-discovery')
    await expect(
      listClaudeTranscriptFiles({
        platform: 'win32',
        configDir: NATIVE_CONFIG,
        includeWslHomes: true,
        listWslHomeDirs: async () => [WSL_HOME]
      })
    ).resolves.toEqual([WSL_FILE])
  })
})

describe('Claude usage transcript parsing from WSL paths', () => {
  it('uses the gated stat and stream for a WSL transcript', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'wsl-session',
      timestamp: '2026-04-09T10:00:00.000Z',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 2 } }
    })
    wslStreamMock.mockReturnValue(Readable.from([line]))

    const { readClaudeUsageScanFile } = await import('./transcript-record-parser')
    const result = await readClaudeUsageScanFile(WSL_FILE)

    expect(result.processedFile).toMatchObject({
      path: WSL_FILE,
      mtimeMs: 123,
      size: 10,
      lineCount: 1
    })
    expect(result.turns[0]).toMatchObject({
      sessionId: 'wsl-session',
      inputTokens: 10,
      outputTokens: 2
    })
    expect(wslStatMock).toHaveBeenCalledWith(WSL_FILE, 'scan')
    expect(wslStreamMock).toHaveBeenCalledWith(WSL_FILE, { encoding: 'utf-8' }, 'scan')
  })
})
