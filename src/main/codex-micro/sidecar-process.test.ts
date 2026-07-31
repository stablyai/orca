import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCodexMicroFrame } from './sidecar-frame-codec'
import type { CodexMicroSidecarProcess as CodexMicroSidecarProcessClass } from './sidecar-process'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { write: vi.fn(), writtenBuffers: [] as Buffer[] }
  killed = false
  kill = vi.fn(() => {
    this.killed = true
    return true
  })
}

describe('CodexMicroSidecarProcess', () => {
  const children: FakeChildProcess[] = []
  let CodexMicroSidecarProcess: typeof CodexMicroSidecarProcessClass

  beforeEach(async () => {
    children.length = 0
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess()
      children.push(child)
      return child
    })
    ;({ CodexMicroSidecarProcess } = await import('./sidecar-process'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('spawns the binary with piped stdio and does not spawn a second child while one is alive', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    proc.start()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      '/path/to/codex-micro',
      [],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('emits a decoded frame reassembled across multiple stdout chunks', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    const child = children[0]!
    const onFrame = vi.fn()
    proc.on('frame', onFrame)

    const frame = encodeCodexMicroFrame({ type: 'handshake' })
    child.stdout.emit('data', frame.subarray(0, 3))
    child.stdout.emit('data', frame.subarray(3))

    expect(onFrame).toHaveBeenCalledWith({ version: 1, type: 'handshake' })
  })

  it('emits a coarse decode-error reason for malformed stdout data, never the raw bytes', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    const child = children[0]!
    const onDecodeError = vi.fn()
    proc.on('decode-error', onDecodeError)

    const body = Buffer.from('not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    child.stdout.emit('data', Buffer.concat([header, body]))

    expect(onDecodeError).toHaveBeenCalledWith('malformed')
    expect(onDecodeError).not.toHaveBeenCalledWith(expect.stringContaining('not json'))
  })

  it('encodes an outgoing message and writes it to stdin', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    const child = children[0]!

    proc.write({ type: 'release' })

    expect(child.stdin.write).toHaveBeenCalledWith(encodeCodexMicroFrame({ type: 'release' }))
  })

  it('waits for stdio close before forwarding exit for the live child', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    const child = children[0]!
    const onExit = vi.fn()
    proc.on('exit', onExit)

    child.emit('exit', 1, null)
    expect(onExit).not.toHaveBeenCalled()
    child.emit('close', 1, null)

    expect(onExit).toHaveBeenCalledWith(1, null)
  })

  it('ignores late data/exit events from a child replaced after stop()+start()', () => {
    const proc = new CodexMicroSidecarProcess('/path/to/codex-micro')
    proc.start()
    const staleChild = children[0]!
    proc.stop()
    proc.start()
    expect(children.length).toBe(2)

    const onFrame = vi.fn()
    const onExit = vi.fn()
    proc.on('frame', onFrame)
    proc.on('exit', onExit)

    staleChild.stdout.emit('data', encodeCodexMicroFrame({ type: 'handshake' }))
    staleChild.emit('close', 1, null)

    expect(onFrame).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })
})
