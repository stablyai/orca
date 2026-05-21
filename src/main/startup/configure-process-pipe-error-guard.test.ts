import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn(() => ''),
      setPath: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      isPackaged: false,
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    }
  }
})

describe('installUncaughtPipeErrorGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses uncaught pipe errors', async () => {
    const { installUncaughtPipeErrorGuard } = await import('./configure-process')
    const originalOn = process.on.bind(process)
    let handler: ((error: unknown) => void) | null = null
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      if (event === 'uncaughtException') {
        handler = listener as (error: unknown) => void
        return process
      }
      return originalOn(event, listener)
    }) as typeof process.on)

    installUncaughtPipeErrorGuard()

    const pipeError = new Error('broken pipe') as NodeJS.ErrnoException
    pipeError.code = 'EPIPE'
    expect(() => handler?.(pipeError)).not.toThrow()
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function))
  })

  it('rethrows non-pipe errors outside the uncaughtException handler', async () => {
    const { installUncaughtPipeErrorGuard } = await import('./configure-process')
    const originalOn = process.on.bind(process)
    const originalOff = process.off.bind(process)
    let handler: ((error: unknown) => void) | null = null
    let scheduled: (() => void) | null = null
    vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      if (event === 'uncaughtException') {
        handler = listener as (error: unknown) => void
        return process
      }
      return originalOn(event, listener)
    }) as typeof process.on)
    const offSpy = vi.spyOn(process, 'off').mockImplementation(((event, listener) => {
      if (event === 'uncaughtException') {
        return process
      }
      return originalOff(event, listener)
    }) as typeof process.off)
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback) => {
      scheduled = callback as () => void
      return {} as NodeJS.Immediate
    }) as typeof setImmediate)

    installUncaughtPipeErrorGuard()

    const error = new Error('boom')
    expect(() => handler?.(error)).not.toThrow()
    expect(offSpy).toHaveBeenCalledWith('uncaughtException', handler)
    expect(scheduled).not.toBeNull()
    expect(() => scheduled?.()).toThrow(error)
  })
})
