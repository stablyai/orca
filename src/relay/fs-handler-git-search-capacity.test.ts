import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))
import { searchWithGitGrep } from './fs-handler-git-search'
import { GitGrepRecordCapacityError } from '../shared/git-grep-record-limit'

class SearchProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}

function start() {
  const child = new SearchProcess()
  spawnMock.mockReturnValue(child)
  return { child, result: searchWithGitGrep('/repo', 'ok', { maxResults: 100 }) }
}

describe('git search record capacity', () => {
  it('rejects an unterminated record past 8 MiB and detaches even when kill fails', async () => {
    const { child, result } = start()
    child.kill.mockImplementation(() => {
      throw new Error('kill refused')
    })
    const outcome = expect(result).rejects.toThrow(GitGrepRecordCapacityError)
    for (let chunk = 0; chunk < 129; chunk++) {
      child.stdout.write(Buffer.alloc(64 * 1024, 'x'))
    }
    await outcome
    expect(child.kill).toHaveBeenCalled()
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    child.emit('close', 0)
    child.stdout.write('later.ts\x001\x00ok\n')
  })

  it('accepts exactly 8 MiB followed by newline and recovers on the next request', async () => {
    const { child, result } = start()
    child.stdout.write('x'.repeat(8 * 1024 * 1024))
    child.stdout.write('\nvalid.ts\x001\x00ok\n')
    child.emit('close', 0)
    expect((await result).files).toHaveLength(1)
    const next = start()
    next.child.stdout.write('next.ts\x001\x00ok\n')
    next.child.emit('close', 0)
    expect((await next.result).files[0].relativePath).toBe('next.ts')
  })

  it('releases the carry on cancellation before reaching the cap', async () => {
    const child = new SearchProcess()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const result = searchWithGitGrep('/repo', 'ok', { maxResults: 100, signal: controller.signal })
    child.stdout.write('x'.repeat(1024 * 1024))
    controller.abort(new Error('workspace switched'))
    await expect(result).rejects.toThrow('workspace switched')
    expect(child.stdout.listenerCount('data')).toBe(0)
  })
})

it('charges raw bytes before replacement decoding invalid UTF-8', async () => {
  const { child, result } = start()
  child.stdout.write(Buffer.alloc(3 * 1024 * 1024, 0xff))
  child.stdout.write('\nvalid.ts\x001\x00ok\n')
  child.emit('close', 0)
  expect((await result).files[0].relativePath).toBe('valid.ts')
  expect(child.kill).not.toHaveBeenCalled()
})
