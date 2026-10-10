import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  testPtyId,
  type MockDispatcher
} from './pty-handler-test-harness'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import type { RelayPtySourceOutput } from './relay-pty-source-output'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))

describe('relay PTY output continuation', () => {
  let handler: PtyHandler
  let dispatcher: MockDispatcher
  let originalPlatform: PropertyDescriptor | undefined
  let wire: RelayDispatcher
  let publication: RelayPtySourcePublication
  let outputs: { id: string; output: RelayPtySourceOutput }[]
  let hasCapacity: boolean
  let reenter: (() => void) | undefined

  beforeEach(() => {
    ;({ handler, dispatcher, originalPlatform } = beginPtyHandlerTest(mocks))
    wire = new RelayDispatcher((_bytes, settle) => {
      settle({ ok: true })
      return true
    })
    const adapter = new SshPtyConsumerSessionAdapter(wire, 'yield-test')
    publication = new RelayPtySourcePublication(wire, adapter, (id) =>
      handler.handleSourcePublicationCapacity(id)
    )
    outputs = []
    hasCapacity = true
    reenter = undefined
    vi.spyOn(publication, 'accepts').mockReturnValue(true)
    vi.spyOn(publication, 'publish').mockImplementation((id, output) => {
      if (!hasCapacity) {
        return false
      }
      outputs.push({ id, output })
      const callback = reenter
      reenter = undefined
      callback?.()
      return true
    })
    handler.setSourcePublication(publication)
  })

  afterEach(async () => {
    wire.dispose()
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function spawn(): Promise<(data: string) => void> {
    let ingress: ((data: string) => void) | undefined
    mocks.mockPtySpawn.mockReturnValueOnce({
      ...mocks.mockPtyInstance,
      onData: (callback: (data: string) => void) => {
        ingress = callback
      }
    })
    await dispatcher.callRequest('pty.spawn', {})
    if (!ingress) {
      throw new Error('Missing native PTY callback')
    }
    return ingress
  }

  it('keeps the initial batch delay and yields after at most two PTYs without another timer', async () => {
    const first = await spawn()
    const second = await spawn()
    const third = await spawn()
    first('a')
    second('b')
    third('c')
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    const timer = vi.spyOn(globalThis, 'setTimeout')
    vi.advanceTimersByTime(7)
    expect(outputs).toEqual([])
    vi.advanceTimersByTime(1)
    expect(outputs.map(({ id }) => id)).toEqual([testPtyId(1), testPtyId(2)])
    expect(immediate).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.map(({ output }) => output.data)).toEqual(['a', 'b', 'c'])
  })

  it('keeps every source frame in order and lets input run between bounded turns', async () => {
    const ingress = await spawn()
    for (let index = 0; index < 60; index++) {
      ingress(`frame-${index}\r\n`)
    }
    reenter = () => {
      setImmediate(() => dispatcher.callNotification('pty.data', { id: testPtyId(1), data: 'x' }))
    }
    vi.advanceTimersByTime(8)
    expect(outputs).toHaveLength(1)
    expect(mocks.mockPtyInstance.write).not.toHaveBeenCalled()
    await vi.advanceTimersToNextTimerAsync()
    expect(mocks.mockPtyInstance.write).toHaveBeenCalledWith('x')
    expect(outputs.length).toBeLessThan(60)
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.map(({ output }) => output.data)).toEqual(
      Array.from({ length: 60 }, (_, index) => `frame-${index}\r\n`)
    )
  })

  it('stops yielding when admission fails and resumes only when capacity returns', async () => {
    const ingress = await spawn()
    ingress('first')
    ingress('second')
    ingress('third')
    vi.advanceTimersByTime(8)
    hasCapacity = false
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    const timerCount = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.map(({ output }) => output.data)).toEqual(['first'])
    expect(publication.publish).toHaveBeenCalledTimes(2)
    expect(immediate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBeLessThan(timerCount)
    hasCapacity = true
    handler.handleSourcePublicationCapacity(testPtyId(1))
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.map(({ output }) => output.data)).toEqual(['first', 'second', 'third'])
  })

  it('preserves FIFO when native ingress arrives between continuation turns', async () => {
    const ingress = await spawn()
    ingress('first')
    ingress('second')
    reenter = () => {
      setImmediate(() => ingress('third'))
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.map(({ output }) => output.data)).toEqual(['first', 'second', 'third'])
  })

  it('does not schedule a continuation when the first admission fails', async () => {
    const ingress = await spawn()
    hasCapacity = false
    ingress('blocked')
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    await vi.advanceTimersByTimeAsync(100)
    expect(publication.publish).toHaveBeenCalledTimes(1)
    expect(outputs).toEqual([])
    expect(immediate).not.toHaveBeenCalled()
  })

  it.each(['attach', 'dispose'])('cancels a queued continuation on %s', async (action) => {
    const ingress = await spawn()
    ingress('first')
    ingress('second')
    ingress('third')
    vi.advanceTimersByTime(8)
    const clear = vi.spyOn(globalThis, 'clearImmediate')
    await (action === 'attach'
      ? dispatcher.callRequest('pty.attach', {
          id: testPtyId(1),
          suppressReplayNotification: true
        })
      : handler.dispose({ waitForPhysicalExit: false }))
    expect(clear).toHaveBeenCalledTimes(1)
    const outputCount = outputs.length
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs).toHaveLength(outputCount)
  })
})
