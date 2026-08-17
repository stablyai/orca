import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { herdrSessionControlArgs } from './herdr-session-control'

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

describe('createStockHerdrTerminalController', () => {
  it('attaches with terminal session control when commandFor is set', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    const { createStockHerdrTerminalController } = await import('./herdr-terminal-observe')
    const commandFor = vi.fn((args: string[]) => ({ file: '/mock/herdr', args }))
    const controller = createStockHerdrTerminalController(
      'orca',
      'w1:p1',
      { cols: 100, rows: 30 },
      {
        commandFor,
        request: vi.fn(),
        onEvent: vi.fn(() => () => undefined)
      }
    )
    expect(commandFor).toHaveBeenCalledWith(
      herdrSessionControlArgs('orca', 'w1:p1', { cols: 100, rows: 30 })
    )
    expect(commandFor.mock.calls[0][0]).not.toContain('observe')
    controller.write('x')
    controller.resize(132, 43)
    expect(child.stdin.write.mock.calls.map((call) => call[0])).toEqual([
      '{"type":"terminal.input","text":"x"}\n',
      '{"type":"terminal.resize","cols":132,"rows":43}\n'
    ])
    controller.release()
  })
})
