import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, stopMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), stopMock: vi.fn() }))
vi.mock('../ripgrep/bundled-ripgrep-spawn', () => ({ spawnBundledRipgrep: spawnMock }))
vi.mock('../ripgrep/bundled-ripgrep-stop', () => ({ stopBundledRipgrep: stopMock }))

import { listMarkdownDocuments } from './markdown-documents'

class ListingProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 123
  kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true)
}

const root = resolve('/workspace/docs')
const originalPlatform = process.platform
let child: ListingProcess

beforeEach(() => {
  child = new ListingProcess()
  spawnMock.mockReset().mockReturnValue(child)
  stopMock.mockReset().mockImplementation((process: ListingProcess) => process.kill('SIGKILL'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('Markdown document ripgrep lifecycle', () => {
  it.each(['../escape.md', '/outside.md', './dir/../escape.md'])(
    'rejects a path outside the relative listing protocol: %s',
    async (path) => {
      const result = listMarkdownDocuments(root)
      child.stdout.write('./README.md\0')
      child.stdout.write(`${path}\0`)
      await expect(result).rejects.toThrow('Invalid path')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }
  )
})
