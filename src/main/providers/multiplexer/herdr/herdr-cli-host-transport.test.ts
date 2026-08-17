import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localHerdrCommand } from './herdr-command'

const spawnMock = vi.fn()
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

async function loadTransport() {
  const mocks = await import('node:child_process')
  const { HerdrCliHostTransport } = await import('./herdr-cli-host-transport')
  const transport = new HerdrCliHostTransport({
    commandFor: localHerdrCommand('/mock/herdr')
  })
  return { transport, spawn: mocks.spawn as ReturnType<typeof vi.fn> }
}

describe('HerdrCliHostTransport', () => {
  it('parses a JSON response from herdr stdout', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const promise = transport.request('main', 'session.snapshot', {})
    child.stdout.emit('data', JSON.stringify({ id: '1', result: { sessions: [] } }))
    child.emit('close', 0)
    const response = await promise
    expect(response).toEqual({ id: '1', result: { sessions: [] } })
  })

  it('rejects an invalid response from herdr', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const promise = transport.request('main', 'session.snapshot', {})
    child.stdout.emit('data', 'not json')
    child.emit('close', 0)
    await expect(promise).rejects.toMatchObject({ code: 'herdr_invalid_response' })
  })

  it('streams terminal frames and buffers them until subscribed', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const controller = transport.controlTerminal('ws', 'w1:p1', { cols: 80, rows: 24 })
    const frames: { seq: number }[] = []
    controller.onFrame((frame) => frames.push(frame as { seq: number }))
    child.stdout.emit('data', `${JSON.stringify({ type: 'terminal.frame', seq: 1, bytes: 'x' })}\n`)
    child.stdout.emit('data', `${JSON.stringify({ type: 'terminal.frame', seq: 2, bytes: 'y' })}\n`)
    expect(frames.map((f) => f.seq)).toEqual([1, 2])
  })

  it('emits closed on a terminal.closed frame', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const controller = transport.controlTerminal('ws', 'w1:p1', { cols: 80, rows: 24 })
    const closed: unknown[] = []
    controller.onClosed((event) => closed.push(event))
    child.stdout.emit('data', `${JSON.stringify({ type: 'terminal.closed', reason: 'gone' })}\n`)
    expect(closed).toEqual([{ type: 'terminal.closed', reason: 'gone' }])
  })

  it('sends input, resize, and release over stdin', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const controller = transport.controlTerminal('ws', 'w1:p1', { cols: 80, rows: 24 })
    controller.write('hello')
    controller.resize(120, 40)
    controller.release()

    const writes = child.stdin.write.mock.calls.map((c) => c[0] as string)
    expect(writes).toEqual([
      '{"type":"terminal.input","text":"hello"}\n',
      '{"type":"terminal.resize","cols":120,"rows":40}\n',
      '{"type":"terminal.release"}\n'
    ])
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('emits closed when the child exits without releasing', async () => {
    const { transport, spawn } = await loadTransport()
    const child = createChild()
    spawn.mockReturnValue(child)

    const controller = transport.controlTerminal('ws', 'w1:p1', { cols: 80, rows: 24 })
    const closed: { reason: string }[] = []
    controller.onClosed((event) => closed.push(event))
    child.emit('close', 1)
    expect(closed.length).toBe(1)
  })
})
