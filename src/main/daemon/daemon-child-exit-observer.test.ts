import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { observeDaemonChildExit } from './daemon-child-exit-observer'

function createChild() {
  const child = new EventEmitter()
  const stderr = new PassThrough() as PassThrough & { unref: () => void }
  stderr.unref = vi.fn<() => void>()
  return Object.assign(child, { stderr })
}

describe('observeDaemonChildExit', () => {
  it('reports an exact post-readiness exit with the bounded stderr tail', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit, 12)

    child.stderr.write('discarded startup\n')
    observer.markReady()
    child.stderr.write('prefix-FATAL')
    child.emit('exit', 134, null)
    child.stderr.emit('end')

    expect(child.stderr.unref).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith({
      verdict: 'exited',
      exitCode: 134,
      signal: null,
      stderrTail: 'prefix-FATAL'
    })
  })

  it('retains trailing stderr until the pipe ends after process exit', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    observer.markReady()
    child.emit('exit', 134, null)
    child.stderr.write('late fatal bytes')
    child.stderr.emit('end')

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 134, stderrTail: 'late fatal bytes' })
    )
  })

  it('retains only the configured bytes from an oversized stderr chunk', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit, 8)

    observer.markReady()
    child.stderr.write(Buffer.from(`${'x'.repeat(1024 * 1024)}FATAL`))
    child.emit('exit', 134, null)
    child.stderr.emit('end')

    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ stderrTail: 'xxxFATAL' }))
  })

  it('reports once when stderr closes before the child exits', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    observer.markReady()
    child.stderr.emit('close')
    child.emit('exit', 134, null)
    child.emit('exit', 134, null)

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ stderrTail: '' }))
  })

  it('swallows stderr errors after process exit while awaiting drain', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    observer.markReady()
    child.emit('exit', 134, null)

    expect(() => child.stderr.emit('error', new Error('late pipe error'))).not.toThrow()
    child.stderr.emit('end')
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('swallows stderr errors before readiness', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    expect(() => child.stderr.emit('error', new Error('startup pipe error'))).not.toThrow()
    expect(onExit).not.toHaveBeenCalled()
    observer.stop()
  })

  it('does not infer an exit from stderr or contact loss', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    child.stderr.write('socket closed')
    observer.markReady()
    child.emit('disconnect')
    child.stderr.emit('error', new Error('broken pipe'))

    expect(onExit).not.toHaveBeenCalled()
    observer.stop()
  })

  it('retains fatal stderr that arrives before the independent ready IPC callback', () => {
    const child = createChild()
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    child.stderr.write('FATAL ERROR before ready dispatch')
    observer.markReady()
    child.emit('exit', 134, null)
    child.stderr.emit('end')

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ stderrTail: 'FATAL ERROR before ready dispatch' })
    )
  })

  it('stops observing and destroys the startup pipe on launch failure', () => {
    const child = createChild()
    const destroy = vi.spyOn(child.stderr, 'destroy')
    const onExit = vi.fn()
    const observer = observeDaemonChildExit(child, onExit)

    child.stderr.write('startup failure')
    expect(observer.startupStderrTail()).toBe('startup failure')
    observer.stop({ destroyStderr: true })
    child.emit('exit', 1, null)

    expect(destroy).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
  })
})
