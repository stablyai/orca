import type { ChildProcess, ForkOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { FilesystemHostParentMessage } from '../../shared/filesystem-host-protocol'
import { FilesystemHostProcess } from './filesystem-host-process'

class FakeChild extends EventEmitter {
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: FilesystemHostParentMessage[] = []
  readonly kill = vi.fn(() => true)

  send(message: FilesystemHostParentMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }
}

describe('FilesystemHostProcess', () => {
  const workerId = randomUUID()

  it('launches with a scrubbed environment and validates child messages', async () => {
    const child = new FakeChild()
    const captured: { options?: ForkOptions } = {}
    const started = FilesystemHostProcess.start({
      entryPath: '/safe/filesystem-host-entry.js',
      spawn: (_entry, _args, options) => {
        captured.options = options
        queueMicrotask(() => child.emit('message', { type: 'ready', protocolVersion: 1, workerId }))
        return child as unknown as ChildProcess
      }
    })
    const process = await started

    expect(captured.options).toMatchObject({
      execArgv: [],
      serialization: 'advanced',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(captured.options?.env).not.toHaveProperty('HOME')

    const result = process.invoke({ kind: 'canonicalize-path', path: '/repo' }, 1_000, 'request-1')
    child.emit('message', {
      type: 'result',
      requestId: 'request-1',
      ok: true,
      result: { kind: 'read-orca-yaml', contents: 'wrong result kind' }
    })
    await expect(result).rejects.toMatchObject({ code: 'protocol' })
  })

  it('ignores late settlement after a deadline and reports physical exit separately', async () => {
    const child = new FakeChild()
    const onPhysicalExit = vi.fn()
    const process = await FilesystemHostProcess.start({
      entryPath: 'unused',
      readyTimeoutMs: 100,
      exitDeadlineMs: 100,
      hardKillDelayMs: 20,
      onPhysicalExit,
      spawn: () => {
        queueMicrotask(() => child.emit('message', { type: 'ready', protocolVersion: 1, workerId }))
        return child as unknown as ChildProcess
      }
    })

    const result = process.invoke(
      { kind: 'canonicalize-path', path: '/stalled' },
      10,
      'late-request'
    )
    await expect(result).rejects.toMatchObject({ code: 'deadline' })
    child.emit('message', {
      type: 'result',
      requestId: 'late-request',
      ok: true,
      result: { kind: 'canonicalize-path', canonicalPath: '/stalled' }
    })

    const retiring = process.retire()
    expect(onPhysicalExit).not.toHaveBeenCalled()
    child.emit('exit', null, 'SIGTERM')
    await expect(retiring).resolves.toBe(true)
    expect(onPhysicalExit).toHaveBeenCalledOnce()
  })

  it('does not reject a failed startup until retirement settles', async () => {
    const child = new FakeChild()
    const started = FilesystemHostProcess.start({
      entryPath: 'unused',
      readyTimeoutMs: 5,
      exitDeadlineMs: 100,
      hardKillDelayMs: 20,
      spawn: () => child as unknown as ChildProcess
    })
    let settled = false
    void started.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled())
    expect(settled).toBe(false)
    child.emit('exit', null, 'SIGTERM')

    await expect(started).rejects.toMatchObject({ code: 'deadline' })
    expect(settled).toBe(true)
  })
})
