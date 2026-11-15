import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBoundedLogFileWriter } from './bounded-log-file-writer'

const io = vi.hoisted(() => ({ open: vi.fn(), rename: vi.fn(), stat: vi.fn() }))
vi.mock('node:fs/promises', () => io)

let files: Map<string, string>
beforeEach(() => {
  vi.useFakeTimers()
  files = new Map()
  io.stat.mockImplementation(async (path: string) => {
    if (!files.has(path)) {
      throw Object.assign(new Error('Missing'), { code: 'ENOENT' })
    }
    return { size: Buffer.byteLength(files.get(path) ?? '') }
  })
  io.rename.mockImplementation(async (from: string, to: string) => {
    if (files.has(from)) {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    }
  })
  io.open.mockImplementation(openFile)
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

async function openFile(path: string) {
  return {
    write: async (buffer: Buffer, offset: number) => {
      files.set(path, (files.get(path) ?? '') + buffer.subarray(offset).toString())
      return { bytesWritten: buffer.length - offset }
    },
    close: async () => {}
  }
}

function writer() {
  return createBoundedLogFileWriter({
    filePath: 'log',
    maxBytes: 8,
    maxFiles: 2,
    maxQueuedChars: 32,
    batchWindowMs: 200,
    formatDroppedLine: () => '!\n'
  })
}

it('rotates a final async batch instead of appending beyond the file cap', async () => {
  files.set('log', '123456\n')
  const log = writer()
  log.write('ab\n')
  await log.closeAsync(500)
  expect(Object.fromEntries(files)).toEqual({ 'log.1': '123456\n', log: 'ab\n' })
  log.write('late\n')
  await log.flush()
  expect(Object.fromEntries(files)).toEqual({ 'log.1': '123456\n', log: 'ab\n' })
})

it('drops the final batch when rotation fails instead of exceeding the cap', async () => {
  files.set('log', '123456\n')
  io.rename.mockRejectedValue(new Error('Storage unavailable'))
  const log = writer()
  log.write('ab\n')
  await log.closeAsync(500)
  expect(Object.fromEntries(files)).toEqual({ log: '123456\n' })
})

it('drops pending writes at the shutdown deadline without replay after slow storage recovers', async () => {
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  io.stat.mockImplementation(async () => {
    await blocked
    return { size: 0 }
  })
  const log = writer()
  log.write('old\n')
  const flushing = log.flush()
  log.write('new\n')
  const closing = log.closeAsync(500)
  await vi.advanceTimersByTimeAsync(500)
  await closing
  expect(Object.fromEntries(files)).toEqual({})
  release()
  await flushing
  await log.flush()
  expect(Object.fromEntries(files)).toEqual({})
})

it('does not write through a handle acquired after its close deadline', async () => {
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  io.open.mockImplementation(async (path: string) => {
    await blocked
    return openFile(path)
  })
  const log = writer()
  log.write('old\n')
  const flushing = log.flush()
  const closing = log.closeAsync(500)
  await vi.advanceTimersByTimeAsync(500)
  await closing
  release()
  await flushing
  expect(Object.fromEntries(files)).toEqual({})
})

it('settles failed storage and admits nothing after close', async () => {
  io.open.mockRejectedValue(new Error('Storage unavailable'))
  const log = writer()
  log.write('old\n')
  await log.closeAsync(500)
  log.write('late\n')
  await log.flush()
  expect(Object.fromEntries(files)).toEqual({})
})

it('drops an oversized batch and can write a later bounded record', async () => {
  const log = writer()
  log.write('123456789\n')
  await log.flush()
  log.write('ok\n')
  await log.closeAsync(500)
  expect(Object.fromEntries(files)).toEqual({ log: '!\nok\n' })
})

it('refuses a final append when the current file size is unavailable', async () => {
  files.set('log', '123456\n')
  io.stat.mockRejectedValue(new Error('Storage unavailable'))
  const log = writer()
  log.write('ab\n')
  await log.closeAsync(500)
  expect(Object.fromEntries(files)).toEqual({ log: '123456\n' })
})
