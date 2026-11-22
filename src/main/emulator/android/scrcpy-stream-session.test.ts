import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrcpyStreamSession } from './scrcpy-stream-session'

const io = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: io.spawn }))
vi.mock('node:net', () => ({ connect: io.connect }))
vi.mock('../emulator-probe', () => ({ emulatorProbe: vi.fn(), emulatorProbeError: vi.fn() }))

class TestSocket extends EventEmitter {
  destroyed = false
  destroy = vi.fn()
  setTimeout = vi.fn()
  setNoDelay = vi.fn()
  write = vi.fn()
}

function packet(size: number, meta = 123n): Buffer {
  const result = Buffer.alloc(12 + size, 7)
  result.writeBigUInt64BE(meta, 0)
  result.writeUInt32BE(size, 8)
  return result
}

function handshake(): Buffer {
  const result = Buffer.alloc(77)
  result.write('test-device', 1)
  result.write('h264', 65)
  result.writeUInt32BE(1080, 69)
  result.writeUInt32BE(2400, 73)
  return result
}

async function startSession() {
  const video = new TestSocket()
  const control = new TestSocket()
  const server = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
  io.spawn.mockReturnValue(server)
  io.connect.mockReturnValueOnce(video).mockReturnValueOnce(control)
  const callbacks = { onMeta: vi.fn(), onFrame: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: '41234\n', stderr: '' })
  const started = ScrcpyStreamSession.start(
    {
      runner,
      sdk: { sdkRoot: 'sdk', adb: 'adb', emulator: 'emulator' },
      serial: 'test-device',
      localJarPath: 'server.jar'
    },
    callbacks
  )
  await vi.waitFor(() => expect(io.connect).toHaveBeenCalledTimes(1))
  return { video, control, server, runner, callbacks, started }
}

beforeEach(() => {
  io.spawn.mockReset()
  io.connect.mockReset()
})

describe('ScrcpyStreamSession video buffering', () => {
  it('accepts bytewise handshake and frames, including empty chunks and empty frames', async () => {
    const { video, callbacks, started } = await startSession()
    const header = handshake()
    for (let index = 0; index < header.length - 1; index += 1) {
      video.emit('data', header.subarray(index, index + 1))
    }
    expect(callbacks.onMeta).not.toHaveBeenCalled()
    video.emit('data', header.subarray(-1))
    const session = await started
    expect(callbacks.onMeta).toHaveBeenCalledWith({ codecId: 'h264', width: 1080, height: 2400 })
    const stream = Buffer.concat([packet(0, 1n << 63n), packet(3, (1n << 62n) | 5n)])
    for (const byte of stream) {
      video.emit('data', Buffer.alloc(0))
      video.emit('data', Buffer.from([byte]))
    }
    expect(callbacks.onFrame.mock.calls.map(([frame]) => frame)).toEqual([
      { config: true, keyFrame: false, pts: 0n, data: Buffer.alloc(0) },
      { config: false, keyFrame: true, pts: 5n, data: Buffer.alloc(3, 7) }
    ])
    session.close()
  })

  it('owns pending bytes and emitted frames independently of input chunks', async () => {
    const { video, callbacks, started } = await startSession()
    video.emit('data', handshake())
    const session = await started
    const first = packet(4)
    const second = packet(6, 456n)
    const chunk = Buffer.concat([first, second.subarray(0, 14)])
    video.emit('data', chunk)
    chunk.fill(0)
    const tail = Buffer.from(second.subarray(14))
    video.emit('data', tail)
    tail.fill(0)
    expect(callbacks.onFrame.mock.calls.map(([frame]) => frame)).toEqual([
      { config: false, keyFrame: false, pts: 123n, data: Buffer.alloc(4, 7) },
      { config: false, keyFrame: false, pts: 456n, data: Buffer.alloc(6, 7) }
    ])
    session.close()
  })

  it('fails an already started session on a corrupt batch without delivering partial results', async () => {
    const { video, callbacks, started } = await startSession()
    video.emit('data', handshake())
    const session = await started
    const corrupt = packet(0)
    corrupt.writeUInt32BE(16 * 1024 * 1024 + 1, 8)
    video.emit('data', Buffer.concat([packet(1), corrupt]))
    expect(callbacks.onFrame).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/desynced/))
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
    session.close()
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  })

  it('does not resolve startup or deliver earlier frames if the first batch is desynced', async () => {
    const { video, callbacks, started, server, runner } = await startSession()
    const corrupt = packet(0)
    corrupt.writeUInt32BE(16 * 1024 * 1024 + 1, 8)
    const rejected = expect(started).rejects.toThrow(/desynced/)
    video.emit('data', Buffer.concat([handshake(), packet(1), corrupt]))
    await rejected
    expect(callbacks.onMeta).toHaveBeenCalledTimes(1)
    expect(callbacks.onFrame).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
    expect(server.kill).toHaveBeenCalledTimes(1)
    expect(video.destroy).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenLastCalledWith('adb', [
      '-s',
      'test-device',
      'forward',
      '--remove',
      'tcp:41234'
    ])
  })
})

describe('ScrcpyStreamSession control', () => {
  it('tracks the video size control messages must carry across encoder restarts', async () => {
    const { video, callbacks, started } = await startSession()
    video.emit('data', handshake())
    const session = await started
    expect(session.videoSize()).toEqual({ width: 1080, height: 2400 })

    // A rotation restarts the encoder; only the new SPS (here 600x1280) carries the new size.
    const sps = Buffer.from('000000016742c01fd900980a1e5f011000000300100000030320f1832480', 'hex')
    const config = Buffer.alloc(12)
    config.writeBigUInt64BE(1n << 63n, 0)
    config.writeUInt32BE(sps.length, 8)
    video.emit('data', Buffer.concat([config, sps]))

    expect(session.videoSize()).toEqual({ width: 600, height: 1280 })
    expect(callbacks.onFrame).toHaveBeenCalledWith(expect.objectContaining({ config: true }))
    session.close()
  })
})

describe('ScrcpyStreamSession teardown', () => {
  it('removes only its allocated forward and closes its resources once', async () => {
    const { video, control, server, runner, callbacks, started } = await startSession()
    video.emit('data', handshake())
    const session = await started

    session.close()
    session.close()

    expect(runner.mock.calls.filter(([, args]) => args.includes('forward'))).toEqual([
      [
        'adb',
        ['-s', 'test-device', 'forward', 'tcp:0', expect.stringMatching(/^localabstract:scrcpy_/)]
      ],
      ['adb', ['-s', 'test-device', 'forward', '--remove', 'tcp:41234']]
    ])
    expect(video.destroy).toHaveBeenCalledTimes(1)
    expect(control.destroy).toHaveBeenCalledTimes(1)
    expect(server.kill).toHaveBeenCalledTimes(1)
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  })
})
