import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))

import { captureSimulatorLog } from './simctl-log-capture'

/**
 * Creates a controllable child-process double for streaming tests.
 * @returns An event emitter with writable output streams and a kill spy.
 */
function mockChild(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}

describe('captureSimulatorLog', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('streams, parses, and keeps only the requested tail', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1', { lines: 2 })
    child.stdout.write(
      '{"timestamp":"one","messageType":"Info","eventMessage":"first"}\nnot json\n' +
        '{"timestamp":"two","messageType":"Error","eventMessage":"sec'
    )
    child.stdout.write('ond"}\n{"timestamp":"three","messageType":"Fault","eventMessage":"third"}')
    child.emit('close', 0, null)

    await expect(capture).resolves.toEqual([
      { timestamp: 'two', level: 'Error', message: 'second' },
      { timestamp: 'three', level: 'Fault', message: 'third' }
    ])
    expect(spawnMock).toHaveBeenCalledWith({
      program: 'xcrun',
      args: expect.arrayContaining([
        'simctl',
        'spawn',
        'device-1',
        'log',
        'show',
        '--style',
        'ndjson'
      ]),
      stdio: ['ignore', 'pipe', 'pipe']
    })
  })

  it('maps unavailable simctl errors', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1')
    child.emit('error', Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }))

    await expect(capture).rejects.toMatchObject({
      code: 'emulator_simctl_unavailable'
    })
  })

  it('preserves split UTF-8 and final lines through repeated ring wraparound', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1', { lines: 2 })
    for (const message of ['one', 'two', 'three', 'four']) {
      child.stdout.write(`${JSON.stringify({ eventMessage: message })}\n`)
    }
    const final = Buffer.from(JSON.stringify({ eventMessage: '끝🙂' }))
    for (const byte of final) {
      child.stdout.write(Buffer.from([byte]))
    }
    child.emit('close', 0, null)
    await expect(capture).resolves.toEqual([{ message: 'four' }, { message: '끝🙂' }])
  })

  it('rejects oversized records across chunks instead of returning an incomplete tail', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1', { lines: 2 })
    child.stdout.write('{"eventMessage":"before"}\n{"eventMessage":"')
    for (let index = 0; index < 32; index++) {
      child.stdout.write('x'.repeat(4096))
    }
    child.stdout.write('"}{"eventMessage":"suffix must not be parsed"}')
    child.stdout.write('\n{"eventMessage":"after"}\n')
    child.emit('close', 0, null)

    await expect(capture).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('log capture stopped to avoid returning incomplete logs')
    })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('preserves records at the exact byte limit', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1')
    const overhead = Buffer.byteLength(JSON.stringify({ eventMessage: '' }))
    const boundaryMessage = 'x'.repeat(64 * 1024 - overhead)
    child.stdout.write(
      `${JSON.stringify({ eventMessage: boundaryMessage })}\n` + '{"eventMessage":"after"}'
    )
    child.emit('close', 0, null)

    await expect(capture).resolves.toEqual([{ message: boundaryMessage }, { message: 'after' }])
  })

  it.each(['x'.repeat(64 * 1024), '한'.repeat(32 * 1024)])(
    'rejects a complete oversized record using UTF-8 bytes',
    async (message) => {
      const child = mockChild()
      spawnMock.mockReturnValue(child)
      const capture = captureSimulatorLog('device-1')
      child.stdout.write(`${JSON.stringify({ eventMessage: message })}\n`)
      child.emit('close', 0, null)

      await expect(capture).rejects.toMatchObject({
        code: 'emulator_error',
        message: expect.stringContaining('exceeds the 64 KiB limit')
      })
    }
  )

  it('rejects an oversized unterminated record even when the process closes successfully', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1')
    child.stdout.write('x'.repeat(64 * 1024 + 1))
    child.stdout.write('{"eventMessage":"suffix must not be parsed"}')
    child.emit('close', 0, null)

    await expect(capture).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('exceeds the 64 KiB limit')
    })
  })
})
