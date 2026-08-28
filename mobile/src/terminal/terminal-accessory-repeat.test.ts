import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalAccessoryRepeatController,
  createTerminalAccessoryRepeatSender,
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
  TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS
} from './terminal-accessory-repeat'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('terminal accessory repeat', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps one send in flight and preserves repeat order under host latency', async () => {
    vi.useFakeTimers()
    const first = deferred()
    const second = deferred()
    const sent: string[] = []
    const send = vi.fn((input: string) => {
      sent.push(input)
      return (sent.length === 1 ? first.promise : second.promise).then(() => true)
    })
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', send)
    expect(sent).toEqual(['down'])

    await vi.advanceTimersByTimeAsync(TERMINAL_ACCESSORY_REPEAT_DELAY_MS + 500)
    expect(sent).toEqual(['down'])

    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['down', 'down'])

    await vi.advanceTimersByTimeAsync(TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS + 500)
    expect(sent).toEqual(['down', 'down'])

    second.resolve()
    await vi.advanceTimersByTimeAsync(TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS)
    expect(sent).toEqual(['down', 'down', 'down'])
  })

  it('does not schedule another repeat after release while a send is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    const send = vi.fn(() => pending.promise.then(() => true))
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', send)
    repeat.stop()
    pending.resolve()
    await vi.runAllTimersAsync()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('dispatches distinct taps without waiting for prior acknowledgements', async () => {
    vi.useFakeTimers()
    const pending = Array.from({ length: 5 }, () => deferred())
    const sent: string[] = []
    const send = vi.fn((input: string) => {
      sent.push(input)
      return pending[sent.length - 1]!.promise.then(() => true)
    })
    const repeat = createTerminalAccessoryRepeatController<string>()

    for (let index = 0; index < pending.length; index += 1) {
      repeat.start(`tap-${index}`, send)
      repeat.stop()
    }

    expect(sent).toEqual(['tap-0', 'tap-1', 'tap-2', 'tap-3', 'tap-4'])

    pending.forEach(({ resolve }) => resolve())
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('cancels repeats without dropping a distinct tap already dispatched by the user', async () => {
    vi.useFakeTimers()
    const first = deferred()
    const sent: string[] = []
    const send = vi.fn((input: string) => {
      sent.push(input)
      return input === 'down' ? first.promise.then(() => true) : Promise.resolve(true)
    })
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', send)
    repeat.stop()
    repeat.start('up', send)
    repeat.cancel()

    first.resolve()
    await vi.runAllTimersAsync()

    expect(sent).toEqual(['down', 'up'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stops repeating when the transport rejects a send', async () => {
    vi.useFakeTimers()
    const send = vi.fn(() => Promise.reject(new Error('disconnected')))
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', send)
    await vi.runAllTimersAsync()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops repeating when the send is dropped before reaching the transport', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => false)
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', send)
    await vi.runAllTimersAsync()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops sending when the terminal active at press time is no longer active', async () => {
    let activeTerminal = 'terminal-a'
    const sendToTerminal = vi.fn(async () => true)
    const send = createTerminalAccessoryRepeatSender(
      activeTerminal,
      (targetHandle) => activeTerminal === targetHandle,
      sendToTerminal
    )

    await expect(send('down')).resolves.toBe(true)
    activeTerminal = 'terminal-b'
    await expect(send('down')).resolves.toBe(false)

    expect(sendToTerminal).toHaveBeenCalledTimes(1)
    expect(sendToTerminal).toHaveBeenCalledWith('down', 'terminal-a', expect.any(Function))
  })

  it('provides a live target guard for async send preflight', async () => {
    let targetCurrent = true
    const preflight = deferred()
    const send = createTerminalAccessoryRepeatSender(
      'terminal-a',
      () => targetCurrent,
      async (_input, _targetHandle, isDeliveryTargetCurrent) => {
        await preflight.promise
        return isDeliveryTargetCurrent()
      }
    )

    const result = send('down')
    targetCurrent = false
    preflight.resolve()

    await expect(result).resolves.toBe(false)
  })

  it('stops held repeats when the press-time connection is no longer current', async () => {
    vi.useFakeTimers()
    let connectionGeneration = 1
    const first = deferred()
    const sent: string[] = []
    const sendToTerminal = vi.fn((input: string) => {
      sent.push(input)
      return input === 'down' ? first.promise.then(() => true) : Promise.resolve(true)
    })
    const createSender = () => {
      const pressedConnectionGeneration = connectionGeneration
      return createTerminalAccessoryRepeatSender(
        'terminal-a',
        () => connectionGeneration === pressedConnectionGeneration,
        sendToTerminal
      )
    }
    const repeat = createTerminalAccessoryRepeatController<string>()

    repeat.start('down', createSender())

    connectionGeneration = 2
    first.resolve()
    await vi.runAllTimersAsync()

    expect(sent).toEqual(['down'])
  })
})
