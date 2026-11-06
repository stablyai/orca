import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import type { RuntimeChildProcess } from './desktop-script-serve-channel'
import { DesktopScriptRuntimeHost, isRuntimeHostUnavailable } from './desktop-script-runtime-host'

class FakeRuntimeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly writes: string[] = []
  killed = false
  stdinEnded = false
  /** Holds write callbacks so a late stdin failure can be fired deliberately. */
  deferWrites = false
  private readonly pendingWrites: ((error?: Error | null) => void)[] = []

  readonly stdin = {
    write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
      this.writes.push(chunk)
      if (this.deferWrites) {
        if (callback) {
          this.pendingWrites.push(callback)
        }
        return true
      }
      callback?.(null)
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    },
    on: (): void => {}
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  failQueuedWrites(): void {
    for (const callback of this.pendingWrites.splice(0)) {
      callback(new Error('ERR_STREAM_DESTROYED'))
    }
  }

  failQueuedWrite(index: number): void {
    this.pendingWrites.splice(index, 1)[0](new Error('EPIPE'))
  }

  requests(): Record<string, unknown>[] {
    return this.writes.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  pendingId(): number {
    return this.requests().at(-1)?.requestId as number
  }

  ready(): void {
    this.write('{"ready":true}\n')
  }

  respond(response: Record<string, unknown>, requestId = this.pendingId()): void {
    this.write(`${JSON.stringify({ ...response, requestId })}\n`)
  }

  write(raw: string): void {
    this.stdout.emit('data', Buffer.from(raw, 'utf8'))
  }

  exit(code: number | null, stderr = ''): void {
    if (stderr) {
      this.stderr.emit('data', Buffer.from(stderr, 'utf8'))
    }
    this.emit('close', code, null)
  }
}

function createHost(
  options: {
    idleShutdownMs?: number
    requestTimeoutMs?: number
    cooldownMs?: number
    now?: () => number
    deferWrites?: boolean
  } = {}
) {
  const children: FakeRuntimeChild[] = []
  const specs: ProcessSpec[] = []
  const warnings: string[] = []
  const host = new DesktopScriptRuntimeHost('C:\\orca\\runtime.ps1', {
    ...options,
    powerShellPath: () => 'C:\\Windows\\System32\\powershell.exe',
    warn: (message) => warnings.push(message),
    spawn: (spec) => {
      specs.push(spec)
      const child = new FakeRuntimeChild()
      child.deferWrites = options.deferWrites === true
      children.push(child)
      return child as unknown as RuntimeChildProcess
    }
  })
  return { host, children, specs, warnings }
}

/** Let the host's queue microtasks drain so the next request reaches its child. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve()
  }
}

describe('DesktopScriptRuntimeHost', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('serializes requests so only one operation is ever in flight', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'click', app: 'A' })
    const second = host.request({ tool: 'click', app: 'B' })
    await settle()

    expect(children[0].requests()).toEqual([{ tool: 'click', app: 'A', requestId: 1 }])

    children[0].respond({ ok: true, action: { path: 'synthetic' } })
    await expect(first).resolves.toMatchObject({ ok: true })
    await settle()

    expect(children[0].requests()).toHaveLength(2)
    children[0].respond({ ok: true, action: { path: 'accessibility' } })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('reassembles a response split across chunks, including a split code point', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'get_app_state', app: 'Editor' })
    await settle()

    const payload = Buffer.from(
      `${JSON.stringify({ ok: true, snapshot: { app: 'né' }, requestId: 1 })}\r\n`,
      'utf8'
    )
    const split = payload.indexOf(Buffer.from('é', 'utf8')) + 1
    children[0].stdout.emit('data', payload.subarray(0, split))
    children[0].stdout.emit('data', payload.subarray(split))

    await expect(promise).resolves.toEqual({ ok: true, snapshot: { app: 'né' } })
    host.dispose()
  })

  it('kills the helper rather than answering a request with another reply', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} }, 999)

    await expect(first).rejects.toThrow(/did not match the pending request/)
    expect(children[0].killed).toBe(true)
    host.dispose()
  })

  it('times out a wedged operation and starts a fresh helper for the next one', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ requestTimeoutMs: 30_000 })

    const promise = host.request({ tool: 'click', app: 'Frozen' })
    await settle()
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(promise).rejects.toMatchObject({ code: 'action_timeout' })
    expect(children[0].killed).toBe(true)

    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('never re-sends a mutation to a fresh helper after a pre-answer death', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'click', app: 'Notepad', x: 10, y: 10 })
    await settle()
    children[0].exit(1, 'Add-Type : Cannot access the temporary directory')

    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(1)
    host.dispose()
  })

  it('never replays a mutation once the helper announced it was reading', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'click', app: 'Notepad', x: 10, y: 10 })
    await settle()
    children[0].ready()
    // A snapshot can fault after input was delivered; missing replies do not justify replay.
    children[0].exit(1, 'faulting module gdiplus.dll')

    await expect(promise).rejects.toThrow(/runtime host exited/)
    expect(children).toHaveLength(1)
    host.dispose()
  })

  it('replays a mutation only for a helper that died before announcing readiness', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].ready()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    const crashed = host.request({ tool: 'click', app: 'Notepad', x: 1, y: 1 })
    await settle()
    children[0].exit(1, 'boom')
    await expect(crashed).rejects.toThrow(/runtime host exited/)

    const retried = host.request({ tool: 'click', app: 'Notepad', x: 1, y: 1 })
    await settle()
    // This protocol announces before reading requests, so a pre-ready failure is safe to replay.
    children[1].exit(1, 'Add-Type : Cannot access the temporary directory')
    await settle()

    expect(children).toHaveLength(3)
    children[2].ready()
    children[2].respond({ ok: true, action: { path: 'synthetic' } })
    await expect(retried).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('never lets a stale write error stop a replacement helper', async () => {
    const { host, children } = createHost({ deferWrites: true })

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} }, 999)
    await expect(first).rejects.toBeInstanceOf(Error)

    const second = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)

    children[0].failQueuedWrites()

    expect(children[1].killed).toBe(false)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('ignores a write error for a request that already finished', async () => {
    const { host, children } = createHost({ deferWrites: true })

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    const second = host.request({ tool: 'handshake' })
    await settle()

    // A write callback can fail after its reply; only the request ID detects staleness on a live channel.
    children[0].failQueuedWrite(0)

    expect(children[0].killed).toBe(false)
    children[0].respond({ ok: true, capabilities: {} })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('never respawns for a request queued behind dispose', async () => {
    const { host, children } = createHost()
    const first = host.request({ tool: 'handshake' })
    const queued = host.request({ tool: 'handshake' })
    await settle()

    host.dispose()
    await expect(first).rejects.toBeInstanceOf(Error)
    await expect(queued).rejects.toSatisfy(isRuntimeHostUnavailable)
    await settle()

    expect(children).toHaveLength(1)
  })

  it('fails a request that spends its whole timeout queued behind others', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ requestTimeoutMs: 1_000 })

    // Two predecessors keep the queued click behind its wait deadline.
    const first = host.request({ tool: 'get_app_state', app: 'Frozen' })
    const second = host.request({ tool: 'get_app_state', app: 'Frozen' })
    const queued = host.request({ tool: 'click', app: 'Notepad' })
    // Attach rejection handlers before advancing timers to avoid unhandled rejections.
    const firstFailed = expect(first).rejects.toMatchObject({ code: 'action_timeout' })
    const queuedFailed = expect(queued).rejects.toMatchObject({
      code: 'action_timeout',
      message: /waiting for earlier operations/
    })
    await settle()
    expect(children[0].requests()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_001)
    await firstFailed
    await queuedFailed

    children[1].respond({ ok: true, state: {} })
    await expect(second).resolves.toMatchObject({ ok: true })
    await settle()
    expect(children.flatMap((child) => child.requests())).not.toContainEqual(
      expect.objectContaining({ tool: 'click' })
    )

    const next = host.request({ tool: 'handshake' })
    await settle()
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  // Leave now unset to test the default monotonic clock rather than an injected substitute.
})
