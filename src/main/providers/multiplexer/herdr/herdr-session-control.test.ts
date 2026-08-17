import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { herdrSessionControlArgs, type HerdrSessionControlStream } from './herdr-session-control'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

beforeEach(() => {
  spawnMock.mockReset()
})

type MockChild = EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function createChild(): MockChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn(() => true),
      end: vi.fn()
    }),
    stdout: Object.assign(new EventEmitter(), {
      setEncoding: vi.fn()
    }),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
  return child as unknown as MockChild
}

describe('herdrSessionControlArgs', () => {
  it('builds a control attach without takeover', () => {
    expect(herdrSessionControlArgs('orca', 'w1:p1', { cols: 80, rows: 24 })).toEqual([
      '--session',
      'orca',
      'terminal',
      'session',
      'control',
      'w1:p1',
      '--cols',
      '80',
      '--rows',
      '24'
    ])
  })
})

describe('createHerdrSessionControlController', () => {
  it('sends input, resize, and release over stdin', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const { createHerdrSessionControlController } = await import('./herdr-session-control')
    const controller = createHerdrSessionControlController({
      file: '/mock/herdr',
      args: herdrSessionControlArgs('orca', 'w1:p1', { cols: 80, rows: 24 })
    })
    controller.write('\u001b\u007f')
    controller.resize(120, 40)
    controller.release()

    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/herdr',
      herdrSessionControlArgs('orca', 'w1:p1', { cols: 80, rows: 24 }),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
    expect(child.stdin.write.mock.calls.map((call) => call[0])).toEqual([
      `${JSON.stringify({ type: 'terminal.input', text: '\u001b\u007f' })}\n`,
      `${JSON.stringify({ type: 'terminal.resize', cols: 120, rows: 40 })}\n`,
      `${JSON.stringify({ type: 'terminal.release' })}\n`
    ])
  })
})

describe('createHerdrSessionControlFromOpen', () => {
  it('queues writes until the stream opens', async () => {
    const { createHerdrSessionControlFromOpen } = await import('./herdr-session-control')
    let resolveOpen: ((stream: HerdrSessionControlStream) => void) | undefined
    const write = vi.fn<(data: string) => void>()
    const controller = createHerdrSessionControlFromOpen(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    controller.write('hello')
    controller.resize(80, 24)
    expect(write).not.toHaveBeenCalled()
    resolveOpen?.({
      writable: true,
      write,
      end: vi.fn(),
      close: vi.fn(),
      onData: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn()
    })
    await Promise.resolve()
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      `${JSON.stringify({ type: 'terminal.input', text: 'hello' })}\n`,
      `${JSON.stringify({ type: 'terminal.resize', cols: 80, rows: 24 })}\n`
    ])
    controller.release()
  })
})
