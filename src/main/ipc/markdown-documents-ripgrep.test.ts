import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('../ripgrep/bundled-ripgrep-spawn', () => ({ spawnBundledRipgrep: spawnMock }))

import { listMarkdownDocuments } from './markdown-documents'

class ListingProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 123
  kill = vi.fn(() => true)
}

const root = resolve('/workspace/docs')
const originalPlatform = process.platform
let child: ListingProcess

beforeEach(() => {
  child = new ListingProcess()
  spawnMock.mockReset().mockReturnValue(child)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('Markdown document ripgrep lifecycle', () => {
  it('decodes split Unicode and NUL records without splitting newline filenames', async () => {
    const result = listMarkdownDocuments(root)
    const bytes = Buffer.from('./日本語\nnotes.MDX\0./.md\0./script.ts\0./README.md\0')
    for (const byte of bytes) {
      child.stdout.write(Buffer.from([byte]))
    }
    child.emit('close', 0, null)

    expect((await result).map((doc) => doc.basename).sort()).toEqual([
      'README.md',
      '日本語\nnotes.MDX'
    ])
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('accepts an empty listing', async () => {
    const result = listMarkdownDocuments(root)
    child.emit('close', 1, null)
    await expect(result).resolves.toEqual([])
  })

  it('rejects an unreadable subtree even after receiving valid documents', async () => {
    const result = listMarkdownDocuments(root)
    child.stdout.write('./README.md\0')
    child.stderr.write('Permission denied')
    child.emit('close', 2, null)
    await expect(result).rejects.toThrow('Permission denied')
  })

  it('rejects a truncated final path instead of returning partial documents', async () => {
    const result = listMarkdownDocuments(root)
    child.stdout.write('./README.md\0./unfinished.md')
    child.emit('close', 0, null)
    await expect(result).rejects.toThrow('Incomplete path')
  })

  it.each(['../escape.md', '/outside.md', './dir/../escape.md'])(
    'rejects a path outside the relative listing protocol: %s',
    async (path) => {
      const result = listMarkdownDocuments(root)
      child.stdout.write(`${path}\0`)
      await expect(result).rejects.toThrow('Invalid path')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }
  )

  it('rejects an oversized unfinished record without retaining the process', async () => {
    const result = listMarkdownDocuments(root)
    child.stdout.write(`./${'a'.repeat(1024 * 1024)}`)
    await expect(result).rejects.toThrow('path exceeds')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects a spawn failure and does not signal a missing process', async () => {
    const result = listMarkdownDocuments(root)
    child.pid = undefined
    child.emit('error', Object.assign(new Error('missing bundled binary'), { code: 'ENOENT' }))
    await expect(result).rejects.toThrow('missing bundled binary')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects synchronous spawn failures', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn refused')
    })
    await expect(listMarkdownDocuments(root)).rejects.toThrow('spawn refused')
  })

  it('times out, kills the child and releases listeners even if close never arrives', async () => {
    vi.useFakeTimers()
    const result = listMarkdownDocuments(root)
    const rejected = expect(result).rejects.toThrow('timed out')
    child.stdout.write('./README.md\0')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => child.emit('error', new Error('late error'))).not.toThrow()
    expect(() => child.stdout.emit('error', new Error('late pipe error'))).not.toThrow()
  })

  it('rejects stdout failure instead of returning an incomplete set', async () => {
    const result = listMarkdownDocuments(root)
    child.stdout.emit('error', new Error('broken pipe'))
    await expect(result).rejects.toThrow('broken pipe')
  })

  it('does not confuse an unreachable WSL cwd with no matching documents', async () => {
    const result = listMarkdownDocuments(root, { wslDistro: 'Ubuntu' })
    child.emit('close', 97, null)
    await expect(result).rejects.toThrow('Search root is not reachable')
  })

  it.each([
    { path: root, options: { wslDistro: 'Ubuntu' }, distro: 'Ubuntu' },
    { path: '\\\\wsl.localhost\\Debian\\home\\repo', options: {}, distro: 'Debian' }
  ])('selects the Linux binary for $distro', async ({ path, options, distro }) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const result = listMarkdownDocuments(path, options)
    expect(spawnMock).toHaveBeenCalledWith(expect.any(Array), {
      cwd: path,
      wslDistro: options.wslDistro,
      wslDistroForOutput: distro,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.emit('close', 1, null)
    await result
  })
})
