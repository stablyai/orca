import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { searchWithGitGrep } from './filesystem-search-git'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  return p
}

describe('filesystem-search-git', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses git grep output and finds matches', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/mock/root', { query: 'hello', rootPath: '/mock/root' }, 100)

    setTimeout(() => {
      ;(proc.stdout as unknown as EventEmitter).emit(
        'data',
        'src/index.ts\x005:  console.log("hello world")\n'
      )
      ;(proc.stdout as unknown as EventEmitter).emit('data', 'src/main.ts\x0012:  return "hello"\n')
      proc.emit('close')
    }, 10)

    const result = await promise

    expect(result.files).toHaveLength(2)
    expect(result.totalMatches).toBe(2)
    expect(result.truncated).toBe(false)

    expect(result.files[0].relativePath).toBe('src/index.ts')
    expect(result.files[0].matches[0]).toEqual({
      line: 5,
      column: 16,
      matchLength: 5,
      lineContent: '  console.log("hello world")'
    })

    expect(result.files[1].relativePath).toBe('src/main.ts')
    expect(result.files[1].matches[0].line).toBe(12)
  })

  it('finds multiple matches per line', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/mock/root', { query: 'ab', rootPath: '/mock/root' }, 100)

    setTimeout(() => {
      ;(proc.stdout as unknown as EventEmitter).emit('data', 'file.txt\x001:ab cd ab ef ab\n')
      proc.emit('close')
    }, 10)

    const result = await promise

    expect(result.files).toHaveLength(1)
    expect(result.totalMatches).toBe(3)
    expect(result.files[0].matches).toEqual([
      { line: 1, column: 1, matchLength: 2, lineContent: 'ab cd ab ef ab' },
      { line: 1, column: 7, matchLength: 2, lineContent: 'ab cd ab ef ab' },
      { line: 1, column: 13, matchLength: 2, lineContent: 'ab cd ab ef ab' }
    ])
  })

  it('respects maxResults and sets truncated', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/mock/root', { query: 'x', rootPath: '/mock/root' }, 2)

    setTimeout(() => {
      ;(proc.stdout as unknown as EventEmitter).emit(
        'data',
        'a.ts\x001:x\n' + 'b.ts\x001:x\n' + 'c.ts\x001:x\n'
      )
      proc.emit('close')
    }, 10)

    const result = await promise

    expect(result.totalMatches).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('passes correct flags for case-insensitive fixed-string search', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep(
      '/mock/root',
      { query: 'test', rootPath: '/mock/root', caseSensitive: false, useRegex: false },
      100
    )

    setTimeout(() => proc.emit('close'), 10)
    await promise

    const gitArgs = spawnMock.mock.calls[0][1] as string[]
    expect(gitArgs).toContain('-i')
    expect(gitArgs).toContain('--fixed-strings')
    expect(gitArgs).not.toContain('--extended-regexp')
  })

  it('passes correct flags for regex whole-word search', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep(
      '/mock/root',
      {
        query: 'foo',
        rootPath: '/mock/root',
        caseSensitive: true,
        useRegex: true,
        wholeWord: true
      },
      100
    )

    setTimeout(() => proc.emit('close'), 10)
    await promise

    const gitArgs = spawnMock.mock.calls[0][1] as string[]
    expect(gitArgs).toContain('-w')
    expect(gitArgs).toContain('--extended-regexp')
    expect(gitArgs).not.toContain('-i')
    expect(gitArgs).not.toContain('--fixed-strings')
  })

  it('returns empty result when git grep spawn fails', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/mock/root', { query: 'test', rootPath: '/mock/root' }, 100)

    setTimeout(() => proc.emit('error', new Error('spawn git ENOENT')), 10)

    const result = await promise

    expect(result.files).toHaveLength(0)
    expect(result.totalMatches).toBe(0)
  })

  it('skips lines without null separator', async () => {
    const proc = createMockProcess()
    spawnMock.mockReturnValue(proc)

    const promise = searchWithGitGrep('/mock/root', { query: 'ok', rootPath: '/mock/root' }, 100)

    setTimeout(() => {
      // A line without \0 should be skipped (e.g. git header output)
      ;(proc.stdout as unknown as EventEmitter).emit('data', 'no-null-here:1:ok\n')
      ;(proc.stdout as unknown as EventEmitter).emit('data', 'valid.ts\x003:ok\n')
      proc.emit('close')
    }, 10)

    const result = await promise

    expect(result.files).toHaveLength(1)
    expect(result.files[0].relativePath).toBe('valid.ts')
  })
})
