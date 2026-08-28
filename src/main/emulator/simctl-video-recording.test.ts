import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { buildRecordVideoArgs, startSimctlVideoRecording } from './simctl-video-recording'

type FakeChild = EventEmitter & {
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

// simctl announces readiness on stderr before it starts capturing frames.
function announceReady(child: FakeChild): void {
  child.stderr.emit('data', Buffer.from('Recording started\n'))
}

describe('buildRecordVideoArgs', () => {
  it('records h264 and overwrites an existing file', () => {
    expect(buildRecordVideoArgs('UDID-1', '/tmp/demo.mp4')).toEqual([
      'simctl',
      'io',
      'UDID-1',
      'recordVideo',
      '--codec',
      'h264',
      '--force',
      '/tmp/demo.mp4'
    ])
  })
})

describe('startSimctlVideoRecording', () => {
  it('resolves once simctl reports the recording started', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => announceReady(child))
      return child as never
    })

    const recording = await startSimctlVideoRecording('UDID-1', '/tmp/demo.mp4', spawnProcess)

    expect(recording.outputPath).toBe('/tmp/demo.mp4')
    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it('fails fast when simctl rejects the device instead of reporting success', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('Invalid device: BOGUS'))
        child.emit('close', 148, null)
      })
      return child as never
    })

    await expect(
      startSimctlVideoRecording('BOGUS', '/tmp/demo.mp4', spawnProcess)
    ).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('Invalid device: BOGUS')
    })
  })

  it('surfaces a missing xcrun as a simctl availability error', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn xcrun ENOENT')))
      return child as never
    })

    await expect(
      startSimctlVideoRecording('UDID-1', '/tmp/demo.mp4', spawnProcess)
    ).rejects.toMatchObject({ code: 'emulator_simctl_unavailable' })
  })

  it('stops with SIGINT so simctl can mux a playable file', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => announceReady(child))
      return child as never
    })
    const recording = await startSimctlVideoRecording('UDID-1', '/tmp/demo.mp4', spawnProcess)
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    })

    await expect(recording.stop()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a failed mux instead of claiming the file was written', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => announceReady(child))
      return child as never
    })
    const recording = await startSimctlVideoRecording('UDID-1', '/tmp/demo.mp4', spawnProcess)
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('No space left on device'))
        child.emit('close', 1, null)
      })
      return true
    })

    await expect(recording.stop()).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('No space left on device')
    })
  })
})
