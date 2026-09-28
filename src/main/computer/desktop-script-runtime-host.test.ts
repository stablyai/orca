import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { RuntimeChildProcess } from './desktop-script-serve-channel'
import { DesktopScriptRuntimeHost, isRuntimeHostUnavailable } from './desktop-script-runtime-host'

const POLICY_ERROR =
  'File runtime.ps1 cannot be loaded because running scripts\nis disabled on this system.\n    + CategoryInfo : SecurityError'

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

  /** What a destroyed stdin does to writes still queued at teardown. */
  failQueuedWrites(): void {
    for (const callback of this.pendingWrites.splice(0)) {
      callback(new Error('ERR_STREAM_DESTROYED'))
    }
  }

  /** Fail one queued write, leaving later ones outstanding. */
  failQueuedWrite(index: number): void {
    this.pendingWrites.splice(index, 1)[0](new Error('EPIPE'))
  }

  /** Requests written to this child, decoded. */
  requests(): Record<string, unknown>[] {
    return this.writes.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  /** The id the host is currently waiting on, so replies can echo it. */
  pendingId(): number {
    return this.requests().at(-1)?.requestId as number
  }

  /** The announcement the real serve loop writes before its first read. */
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

/** The wait the host reported, read back out of its refusal message. */
function remainingCooldownMs(error: Error | null): number {
  const match = /retrying the runtime host in (\d+)ms/.exec(error?.message ?? '')
  return match ? Number(match[1]) : Number.NaN
}

/** Kill each helper the host starts, until it stops starting them. */
async function failEveryStart(children: FakeRuntimeChild[], stderr: string): Promise<void> {
  for (let index = 0; index < 8; index++) {
    if (index >= children.length) {
      return
    }
    children[index].exit(1, stderr)
    await settle()
  }
}

describe('DesktopScriptRuntimeHost', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts one helper for many operations and never writes an operation file', async () => {
    const { host, children, specs } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await expect(first).resolves.toMatchObject({ ok: true })

    for (let index = 0; index < 5; index++) {
      const next = host.request({ tool: 'click', app: 'Notepad' })
      await settle()
      children[0].respond({ ok: true, action: { path: 'synthetic' } })
      await expect(next).resolves.toMatchObject({ ok: true })
    }

    expect(children).toHaveLength(1)
    expect(children[0].requests()).toHaveLength(6)
    expect(specs[0].args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      'C:\\orca\\runtime.ps1',
      '-Serve'
    ])
    host.dispose()
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

  it('strips the echoed id from the response it hands back', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })

    await expect(promise).resolves.toEqual({ ok: true, capabilities: {} })
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
    // A stray line would otherwise shift every later response by one.
    children[0].respond({ ok: true, capabilities: {} }, 999)

    await expect(first).rejects.toThrow(/did not match the pending request/)
    expect(children[0].killed).toBe(true)
    host.dispose()
  })

  it('kills the helper when an unsolicited line arrives with nothing pending', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    children[0].write(`${JSON.stringify({ ok: true, requestId: 77 })}\n`)
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

  it('rejects the in-flight request when a working helper crashes, then restarts', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    const second = host.request({ tool: 'click', app: 'Notepad' })
    await settle()
    children[0].exit(1, 'boom')

    await expect(second).rejects.toMatchObject({ code: 'accessibility_error' })
    await expect(second).rejects.toThrow(/runtime host exited/)

    const third = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(third).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('stops respawning a helper that dies on every second operation', async () => {
    let clock = 1_000
    const { host, children } = createHost({ cooldownMs: 60_000, now: () => clock })

    // One good answer per helper is exactly the pattern that used to respawn
    // forever: the success reset the failure count before it could ever trip.
    for (let round = 0; round < 3; round++) {
      const good = host.request({ tool: 'handshake' })
      await settle()
      children.at(-1)?.respond({ ok: true, capabilities: {} })
      await expect(good).resolves.toMatchObject({ ok: true })
      await settle()

      const crash = host.request({ tool: 'click', app: 'Crashy' })
      await settle()
      children.at(-1)?.exit(1, 'boom')
      await expect(crash).rejects.toThrow(/runtime host exited/)
      await settle()
    }

    const spawned = children.length
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(spawned)
    host.dispose()
  })

  it('keeps serving a healthy helper after an isolated crash', async () => {
    const { host, children } = createHost({ cooldownMs: 60_000 })

    const crashed = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await crashed
    const second = host.request({ tool: 'click', app: 'Notepad' })
    await settle()
    children[0].exit(1, 'boom')
    await expect(second).rejects.toThrow(/runtime host exited/)

    for (let index = 0; index < 4; index++) {
      const next = host.request({ tool: 'handshake' })
      await settle()
      children.at(-1)?.respond({ ok: true, capabilities: {} })
      await expect(next).resolves.toMatchObject({ ok: true })
    }

    // A clean run clears the count, so one bad helper cannot degrade a good one.
    expect(children).toHaveLength(2)
    host.dispose()
  })

  it('stops respawning a helper that keeps answering the wrong request', async () => {
    let clock = 1_000
    const { host, children } = createHost({ cooldownMs: 60_000, now: () => clock })

    // Desync is host-detected, so it bypassed the exit handler entirely: without
    // its own accounting this respawned once per operation, forever.
    for (let round = 0; round < 3; round++) {
      const promise = host.request({ tool: 'handshake' })
      await settle()
      const child = children.at(-1)
      child?.respond({ ok: true, capabilities: {} }, child.pendingId() + 500)
      await expect(promise).rejects.toThrow(/did not match the pending request/)
      await settle()
    }

    const spawned = children.length
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(spawned)
    host.dispose()
  })

  it('stops respawning a helper that times out on every operation', async () => {
    vi.useFakeTimers()
    let clock = 1_000
    const { host, children } = createHost({
      requestTimeoutMs: 1_000,
      cooldownMs: 60_000,
      now: () => clock
    })

    for (let round = 0; round < 3; round++) {
      const promise = host.request({ tool: 'get_app_state', app: 'Frozen' })
      await settle()
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(promise).rejects.toMatchObject({ code: 'action_timeout' })
      await settle()
    }

    const spawned = children.length
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(spawned)
    host.dispose()
  })

  it('never re-sends a mutation to a fresh helper after a pre-answer death', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'click', app: 'Notepad', x: 10, y: 10 })
    await settle()
    children[0].exit(1, 'Add-Type : Cannot access the temporary directory')

    // The click may already have landed inside the helper that died; replaying
    // it would click twice. An observation in the same position is retried.
    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(1)
    host.dispose()
  })

  it('never replays a mutation once the helper announced it was reading', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'click', app: 'Notepad', x: 10, y: 10 })
    await settle()
    children[0].ready()
    // Past the announcement the click may already have been synthesized: the
    // snapshot that follows it is the fault-prone part, so a missing reply
    // proves nothing about whether the input landed.
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
    // This helper never announced, so it cannot have read the click: replaying
    // is a fact rather than a guess, and the caller never sees the stumble.
    children[1].exit(1, 'Add-Type : Cannot access the temporary directory')
    await settle()

    expect(children).toHaveLength(3)
    children[2].ready()
    children[2].respond({ ok: true, action: { path: 'synthetic' } })
    await expect(retried).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('does not treat the readiness announcement as an unmatched reply', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].ready()

    expect(children[0].killed).toBe(false)
    children[0].respond({ ok: true, capabilities: {} })
    await expect(promise).resolves.toEqual({ ok: true, capabilities: {} })
    host.dispose()
  })

  it('charges one cooldown per outage, not one per later death', async () => {
    let clock = 1_000
    const { host, children } = createHost({ cooldownMs: 60_000, now: () => clock })

    const failed = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, 'The term is not recognized')
    await expect(failed).rejects.toSatisfy(isRuntimeHostUnavailable)

    clock += 61_000
    const recovered = host.request({ tool: 'handshake' })
    await settle()
    children.at(-1)?.respond({ ok: true, capabilities: {} })
    await recovered

    // One death after recovery must not re-enter a full cooldown; the previous
    // outage was already paid for.
    const crashed = host.request({ tool: 'handshake' })
    await settle()
    children.at(-1)?.exit(1, 'boom')
    await expect(crashed).rejects.toBeInstanceOf(Error)

    const next = host.request({ tool: 'handshake' })
    await settle()
    children.at(-1)?.respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('charges one failure when a write fails after the helper was torn down', async () => {
    const { host, children, warnings } = createHost({ deferWrites: true })

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} }, 999)
    await expect(promise).rejects.toThrow(/did not match the pending request/)

    // stop() destroys stdin, so the queued write calls back with an error. That
    // is the same operation failing, not a second one, and counting it twice
    // would drive a 3-strike cooldown at half the intended rate.
    children[0].failQueuedWrites()

    expect(warnings.filter((line) => /helper stopped/.test(line))).toHaveLength(1)
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

    // The late callback belongs to a channel and a request that are both gone.
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

    // Backpressure can hold a write callback past its own response. The channel
    // is alive and was never stopped, so only the request id can tell that this
    // report is stale — this is what pins the host-side guard on its own.
    children[0].failQueuedWrite(0)

    expect(children[0].killed).toBe(false)
    children[0].respond({ ok: true, capabilities: {} })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('shuts the helper down when idle and starts a new one on the next operation', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ idleShutdownMs: 60_000 })

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first
    await settle()

    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(children[0].stdinEnded).toBe(true)
    expect(children[0].killed).toBe(true)

    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('disposes the helper and rejects the in-flight request', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'click', app: 'Notepad' })
    await settle()

    host.dispose()

    expect(children[0].stdinEnded).toBe(true)
    expect(children[0].killed).toBe(true)
    await expect(promise).rejects.toThrow(/shut down/)
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

  it('falls back to Bypass once when the execution policy blocks the start', async () => {
    const { host, children, specs, warnings } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, POLICY_ERROR)
    await settle()

    expect(children).toHaveLength(2)
    expect(specs[1].args).toContain('Bypass')
    children[1].respond({ ok: true, capabilities: {} })
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(warnings.some((line) => /trying Bypass/.test(line))).toBe(true)

    // A helper started under Bypass, so the diagnosis is proven and the fallback
    // is remembered for the session rather than re-probed per call.
    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await next
    expect(warnings.some((line) => /returning to RemoteSigned/.test(line))).toBe(false)
    host.dispose()
  })

  it('returns to RemoteSigned when Bypass does not start a helper either', async () => {
    let clock = 1_000
    const { host, children, specs, warnings } = createHost({ cooldownMs: 60_000, now: () => clock })

    // What AppLocker and WDAC constrained language mode look like: the same
    // SecurityError category, but the block is at script load, so Bypass cannot
    // lift it and the escalation was a misdiagnosis.
    const promise = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, POLICY_ERROR)
    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)

    expect(specs[1].args).toContain('Bypass')
    expect(warnings.some((line) => /returning to RemoteSigned/.test(line))).toBe(true)
    // The revert lands inside the outage, not just at its end: every attempt
    // after the fallback is disproved is back on the preferred policy, so the
    // misdiagnosis costs one Bypass command line rather than one per attempt.
    expect(specs).toHaveLength(3)
    expect(specs[2].args).not.toContain('Bypass')

    // Latching here would put the most heavily weighted MDE token on every
    // later command line, on exactly the hardened host that is watching.
    clock += 61_000
    const recovered = host.request({ tool: 'handshake' })
    await settle()
    expect(specs.at(-1)?.args).not.toContain('Bypass')
    children.at(-1)?.respond({ ok: true, capabilities: {} })
    await expect(recovered).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('reports itself unavailable when Bypass is also refused', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, POLICY_ERROR)

    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
    host.dispose()
  })

  it('reports itself unavailable when the helper cannot be spawned at all', async () => {
    const host = new DesktopScriptRuntimeHost('C:\\orca\\runtime.ps1', {
      powerShellPath: () => 'C:\\Windows\\System32\\powershell.exe',
      warn: () => {},
      spawn: () => {
        throw new Error('spawn ENOENT')
      }
    })

    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    host.dispose()
  })

  it('retries a transient pre-answer death without the caller ever seeing it', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, 'Add-Type : Cannot access the temporary directory')
    await settle()

    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })

    await expect(promise).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('gives up only after repeated start failures, then serves from the host again after the cooldown', async () => {
    let clock = 1_000
    const { host, children, warnings } = createHost({ cooldownMs: 60_000, now: () => clock })

    const failed = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, 'The term is not recognized')
    await expect(failed).rejects.toSatisfy(isRuntimeHostUnavailable)

    const attempts = children.length
    expect(attempts).toBe(3)

    // Inside the cooldown the host stays out of the way without respawning.
    clock += 30_000
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(attempts)

    // Past it, the next operation re-probes rather than staying degraded forever.
    clock += 31_000
    const recovered = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(attempts + 1)
    children[attempts].respond({ ok: true, capabilities: {} })
    await expect(recovered).resolves.toMatchObject({ ok: true })

    expect(warnings.at(-1)).toMatch(/recovered/)
    host.dispose()
  })

  it('keeps the helper account of a reply it could not tag', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    const child = children[0]
    // What an old runtime.ps1 sends when a request will not parse: a real error,
    // with no id to route it by. The desync is honest, but replacing its message
    // reports a broken stream and loses the only account of the cause.
    child.respond({ ok: false, error: 'Invalid object passed in' }, child.pendingId() + 500)

    await expect(promise).rejects.toThrow(
      /did not match the pending request: Invalid object passed in/
    )
    host.dispose()
  })

  it('does not charge a cooldown for requests the helper rejects as malformed', async () => {
    const { host, children } = createHost({ cooldownMs: 60_000 })

    // A tagged error is the helper working, not failing. Three of them used to
    // arrive untagged, and three desync aborts is exactly the cooldown.
    for (let round = 0; round < 3; round++) {
      const promise = host.request({ tool: 'handshake' })
      await settle()
      children[0].respond({ ok: false, error: 'Invalid object passed in' })
      await expect(promise).resolves.toMatchObject({ ok: false })
      await settle()
    }

    expect(children).toHaveLength(1)
    const next = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('fails a request that spends its whole timeout queued behind others', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ requestTimeoutMs: 1_000 })

    // Two ahead of it, because one puts the turn exactly on the deadline.
    const first = host.request({ tool: 'get_app_state', app: 'Frozen' })
    const second = host.request({ tool: 'get_app_state', app: 'Frozen' })
    const queued = host.request({ tool: 'click', app: 'Notepad' })
    // Asserted before the clock moves: both reject while the test is still
    // inside advanceTimersByTimeAsync.
    const firstFailed = expect(first).rejects.toMatchObject({ code: 'action_timeout' })
    // Its own deadline, not the one it would inherit by reaching the head.
    const queuedFailed = expect(queued).rejects.toMatchObject({
      code: 'action_timeout',
      message: /waiting for earlier operations/
    })
    await settle()
    expect(children[0].requests()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_001)
    await firstFailed
    await queuedFailed

    // Drain past the abandoned request: it is never handed to a helper, because
    // a click the caller has been told failed must not still land.
    children[1].respond({ ok: true, state: {} })
    await expect(second).resolves.toMatchObject({ ok: true })
    await settle()
    expect(children.flatMap((child) => child.requests())).not.toContainEqual(
      expect.objectContaining({ tool: 'click' })
    )

    // The request that gave up does not poison the queue behind it.
    const next = host.request({ tool: 'handshake' })
    await settle()
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('gives a queued request its full timeout once it reaches the helper', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ requestTimeoutMs: 1_000 })

    const head = host.request({ tool: 'handshake' })
    const queued = host.request({ tool: 'get_app_state', app: 'Slow' })
    await settle()

    await vi.advanceTimersByTimeAsync(900)
    children[0].respond({ ok: true, capabilities: {} })
    await expect(head).resolves.toMatchObject({ ok: true })
    await settle()

    // Past the point the enqueue deadline would have fired: waiting its turn
    // must not eat the budget the operation itself is entitled to.
    await vi.advanceTimersByTimeAsync(900)
    children[0].respond({ ok: true, state: {} })
    await expect(queued).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  // Both of these deliberately leave `now` unset: the bug was in the default the
  // host picks, so a test that injects a clock cannot see it.
  it('does not stretch the cooldown when the wall clock steps backwards', async () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const { host, children } = createHost({ cooldownMs: 60_000 })

    const failed = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, 'The term is not recognized')
    await expect(failed).rejects.toSatisfy(isRuntimeHostUnavailable)

    // An NTP correction, a VM snapshot restore, a user changing the clock.
    wallClock.mockReturnValue(2_000_000_000_000 - 3_600_000)

    const refused = await host.request({ tool: 'handshake' }).then(
      () => null,
      (error: Error) => error
    )
    expect(refused?.message).toMatch(/retrying the runtime host in/)
    expect(remainingCooldownMs(refused)).toBeLessThanOrEqual(60_000)
    host.dispose()
  })

  it('serves from the persistent helper again after a backwards clock step', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const { host, children } = createHost({ cooldownMs: 25 })

    const failed = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, 'The term is not recognized')
    await expect(failed).rejects.toSatisfy(isRuntimeHostUnavailable)
    const attempts = children.length

    vi.mocked(Date.now).mockReturnValue(2_000_000_000_000 - 3_600_000)
    // Real elapsed time, because the clock under test is the real monotonic one.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const recovered = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(attempts + 1)
    children[attempts].respond({ ok: true, capabilities: {} })
    await expect(recovered).resolves.toMatchObject({ ok: true })
    host.dispose()
  })
})
