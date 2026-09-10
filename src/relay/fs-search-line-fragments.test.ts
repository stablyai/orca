import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { searchWithGitGrep } from './fs-handler-git-fallback'
import { searchWithRg } from './fs-handler-utils'

function createProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(),
    kill: vi.fn()
  }) as unknown as ChildProcess
}

const searchCases = [
  {
    name: 'ripgrep',
    search: searchWithRg,
    encode: (text: string, line: number) =>
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/remote/root/unicode.ts' },
          lines: { text: `${text}\n` },
          line_number: line,
          submatches: [{ start: 0, end: 3 }]
        }
      })
  },
  {
    name: 'git grep',
    search: searchWithGitGrep,
    encode: (text: string, line: number) => `unicode.ts\0${line}\0${text}`
  }
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  spawnMock.mockReset()
})

describe.each(searchCases)('relay $name line fragments', ({ search, encode }) => {
  async function run(chunks: string[]) {
    const child = createProcess()
    spawnMock.mockReturnValueOnce(child)
    const result = search('/remote/root', 'hit', { maxResults: 100 })
    expect(child.stdout!.setEncoding).toHaveBeenCalledWith('utf-8')
    for (const chunk of chunks) {
      child.stdout!.emit('data', chunk)
    }
    child.emit('close', 0, null)
    const value = await result
    expect(child.stdout!.listenerCount('data')).toBe(0)
    expect(child.stderr!.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
    return value
  }

  it('preserves decoded Unicode, batched lines, empty lines and the final unterminated match', async () => {
    const text = 'hit café 漢字 🐋'
    const wire = `${encode(text, 1)}\n\n${encode('hit second', 2)}\n${encode(text, 3)}`
    const complete = await run([wire])
    const fragmented = await run(Array.from(wire))
    expect(fragmented).toEqual(complete)
    expect(fragmented.totalMatches).toBe(3)
    expect(fragmented.truncated).toBe(false)
    expect(fragmented.files[0].matches.map((match) => match.line)).toEqual([1, 2, 3])
    expect(fragmented.files[0].matches[0].lineContent).toBe(text)
    expect(fragmented.files[0].matches[2].lineContent).toBe(text)
  })

  it('does not repeatedly split the growing partial output of a large matching line', async () => {
    const wire = `${encode(`hit ${'x'.repeat(1024 * 1024)}`, 7)}\n`
    const complete = await run([wire])
    const chunks: string[] = []
    for (let offset = 0; offset < wire.length; offset += 4096) {
      chunks.push(wire.slice(offset, offset + 4096))
    }
    const originalSplit = String.prototype.split
    let scannedCharacters = 0
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number
    ) {
      if (separator === '\n') {
        scannedCharacters += this.length
      }
      return Reflect.apply(originalSplit, this, [separator, limit])
    })
    let fragmented
    try {
      fragmented = await run(chunks)
    } finally {
      spy.mockRestore()
    }
    expect(fragmented).toEqual(complete)
    expect(fragmented.totalMatches).toBe(1)
    expect(fragmented.files[0].matches[0].line).toBe(7)
    expect(scannedCharacters).toBe(0)
  })

  it('discards an unfinished line on timeout and detaches the output listeners', async () => {
    vi.useFakeTimers()
    const child = createProcess()
    spawnMock.mockReturnValueOnce(child)
    const result = search('/remote/root', 'hit', { maxResults: 100 })
    child.stdout!.emit('data', `${encode('hit complete', 1)}\n${encode('hit partial', 2)}`)
    await vi.runOnlyPendingTimersAsync()
    const value = await result
    expect(value.totalMatches).toBe(1)
    expect(value.truncated).toBe(true)
    expect(child.kill).toHaveBeenCalled()
    expect(child.stdout!.listenerCount('data')).toBe(0)
    expect(child.stderr!.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    child.stdout!.emit('data', '\n')
    child.emit('close', 0, null)
    expect(value.totalMatches).toBe(1)
  })
})
