import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DebugSessionStateMachine,
  DebugSessionStateMachineError,
  type DapTransport
} from './debug-session-state-machine'

class FakeDapTransport extends EventEmitter implements DapTransport {
  request = vi.fn().mockResolvedValue(undefined)
  close = vi.fn()
}

async function driveToRunning(machine: DebugSessionStateMachine): Promise<void> {
  await machine.initialize({})
  await machine.launch({ request: 'launch', args: {} })
  await machine.configurationDone()
}

describe('DebugSessionStateMachine', () => {
  it('walks the happy path: initialize -> launch -> configurationDone -> running', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)

    expect(machine.state).toBe('initializing')
    await machine.initialize({ adapterID: 'node' })
    expect(machine.state).toBe('launching')
    await machine.launch({ request: 'launch', args: { program: 'index.js' } })
    expect(machine.state).toBe('configuring')
    await machine.configurationDone()
    expect(machine.state).toBe('running')

    expect(transport.request.mock.calls.map(([command]) => command)).toEqual([
      'initialize',
      'launch',
      'configurationDone'
    ])
  })

  it('rejects a second initialize() call', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await machine.initialize({})
    await expect(machine.initialize({})).rejects.toThrow(DebugSessionStateMachineError)
  })

  it('rejects launch() before initialize()', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await expect(machine.launch({ request: 'launch', args: {} })).rejects.toThrow(
      DebugSessionStateMachineError
    )
  })

  it('rejects continue() before configurationDone()', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await machine.initialize({})
    await machine.launch({ request: 'launch', args: {} })
    await expect(machine.continue(1)).rejects.toThrow(DebugSessionStateMachineError)
    expect(transport.request).not.toHaveBeenCalledWith('continue', expect.anything())
  })

  it('allows setBreakpoints while configuring, before configurationDone', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await machine.initialize({})
    await machine.launch({ request: 'launch', args: {} })
    await expect(machine.setBreakpoints({ source: {}, breakpoints: [] })).resolves.toBeUndefined()
  })

  it('transitions to paused on a stopped event and back to running on continued', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await driveToRunning(machine)

    transport.emit('event', {
      seq: 1,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint' }
    })
    expect(machine.state).toBe('paused')

    transport.emit('event', { seq: 2, type: 'event', event: 'continued' })
    expect(machine.state).toBe('running')
  })

  it('allows step/continue/evaluate/threads/stackTrace/variables only while running or paused', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await driveToRunning(machine)

    await expect(machine.continue(1)).resolves.toBeUndefined()
    await expect(machine.pause(1)).resolves.toBeUndefined()
    await expect(machine.stepOver(1)).resolves.toBeUndefined()
    await expect(machine.stepInto(1)).resolves.toBeUndefined()
    await expect(machine.stepOut(1)).resolves.toBeUndefined()
    await expect(machine.evaluate({ expression: '1+1' })).resolves.toBeUndefined()
    await expect(machine.getThreads()).resolves.toBeUndefined()
    await expect(machine.getStackTrace(1)).resolves.toBeUndefined()
    await expect(machine.getVariables(2)).resolves.toBeUndefined()
  })

  it('terminate() is idempotent and disconnects the transport once', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await driveToRunning(machine)

    await machine.terminate()
    expect(machine.state).toBe('terminated')
    expect(transport.close).toHaveBeenCalledTimes(1)

    await machine.terminate()
    expect(transport.close).toHaveBeenCalledTimes(1)
  })

  it('terminate() works from an early lifecycle stage, before the program ever ran', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await machine.initialize({})

    await machine.terminate()
    expect(machine.state).toBe('terminated')
  })

  it('does not block launch() on its response, so an adapter that defers the launch response until configurationDone does not deadlock', async () => {
    const transport = new FakeDapTransport()
    let resolveLaunch: (() => void) | undefined
    transport.request = vi.fn((command: string) => {
      if (command === 'launch') {
        return new Promise<void>((resolve) => {
          resolveLaunch = resolve
        })
      }
      if (command === 'configurationDone') {
        // The adapter only lets the deferred launch response through once
        // configurationDone has been processed — a real vscode-js-debug behavior.
        resolveLaunch?.()
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    const machine = new DebugSessionStateMachine(transport)

    await machine.initialize({})
    await machine.launch({ request: 'launch', args: {} })
    expect(machine.state).toBe('configuring')
    await machine.configurationDone()
    expect(machine.state).toBe('running')
  })

  it('surfaces a launch rejection that has already arrived by the time configurationDone() is called', async () => {
    const transport = new FakeDapTransport()
    transport.request = vi.fn((command: string) =>
      command === 'launch' ? Promise.reject(new Error('spawn ENOENT')) : Promise.resolve(undefined)
    )
    const machine = new DebugSessionStateMachine(transport)
    machine.on('error', () => {})

    await machine.initialize({})
    await machine.launch({ request: 'launch', args: {} })
    await new Promise((resolve) => setImmediate(resolve))
    await expect(machine.configurationDone()).rejects.toThrow(/ENOENT/)
  })

  it('emits an error event for a launch rejection that arrives after configurationDone already succeeded', async () => {
    const transport = new FakeDapTransport()
    let rejectLaunch: ((err: Error) => void) | undefined
    transport.request = vi.fn((command: string) => {
      if (command === 'launch') {
        return new Promise((_resolve, reject) => {
          rejectLaunch = reject
        })
      }
      return Promise.resolve(undefined)
    })
    const machine = new DebugSessionStateMachine(transport)
    const errors: Error[] = []
    machine.on('error', (err: Error) => errors.push(err))

    await machine.initialize({})
    await machine.launch({ request: 'launch', args: {} })
    await machine.configurationDone()
    expect(machine.state).toBe('running')

    rejectLaunch?.(new Error('late failure'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('late failure')
  })

  it('moves to terminated when the transport closes unexpectedly', async () => {
    const transport = new FakeDapTransport()
    const machine = new DebugSessionStateMachine(transport)
    await driveToRunning(machine)

    transport.emit('close')
    expect(machine.state).toBe('terminated')
  })
})
