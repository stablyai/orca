import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { EmulatorGrpcClient } from './emulator-grpc-protocol'
import { EmulatorGrpcSession, startNativeAndroidSession } from './emulator-grpc-session'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function openSession(serial: string) {
  const grpc = new EmulatorGrpcClient({ address: '127.0.0.1:1', token: 'test' })
  const readable = new PassThrough({ objectMode: true })
  const stream = Object.assign(readable, {
    cancel: () => {
      readable.destroy()
    },
    getPeer: () => '127.0.0.1:1',
    getAuthContext: () => null,
    deserialize: () => {
      throw new Error('The fixture emits decoded images directly')
    }
  })
  vi.spyOn(grpc, 'screenshots').mockReturnValue(stream)
  const session = new EmulatorGrpcSession(serial, grpc, { width: 1080, height: 2220 })
  const ended: (boolean | undefined)[] = []
  session.subscribe({
    width: 540,
    height: 1110,
    frame: () => {},
    end: (retry) => ended.push(retry)
  })
  return { session, grpc, stream, ended }
}

it('rejects reuse when the session closes during the display probe', async () => {
  const { session, grpc } = openSession('emulator-9940')
  const display = Promise.withResolvers<{ width: number; height: number }>()
  vi.spyOn(grpc, 'displaySize').mockReturnValue(display.promise)
  try {
    const reusable = session.isReusable()
    await session.close()
    display.resolve({ width: 1080, height: 2220 })

    expect(await reusable).toBe(false)
  } finally {
    await session.close()
  }
})

it('requests scrcpy recovery when an asleep startup stream never delivers pixels', async () => {
  vi.useFakeTimers()
  const { session, stream, ended } = openSession('emulator-9910')
  try {
    stream.write({ format: { width: 0, height: 0 }, image: Buffer.alloc(0) })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(ended).toEqual([true])
    expect(await startNativeAndroidSession('emulator-9910')).toBeNull()
  } finally {
    await session.close()
  }
})

it.each([12, 3])('requests scrcpy recovery for screenshot RPC status %i', async (code) => {
  const serial = `emulator-${9920 + code}`
  const { session, stream, ended } = openSession(serial)
  try {
    stream.emit('error', Object.assign(new Error('Unsupported screenshot RPC'), { code }))
    expect(ended).toEqual([true])
    expect(await startNativeAndroidSession(serial)).toBeNull()
  } finally {
    await session.close()
  }
})
