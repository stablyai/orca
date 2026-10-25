import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type { SshTarget } from '../../../shared/ssh-types'
import type { PlainSshTerminalEvent } from '../../../shared/plain-ssh-terminal'
import {
  ackPlainSshTerminal,
  closeAllPlainSshTerminals,
  closePlainSshTerminal,
  closePlainSshTerminalsOwnedBy,
  openPlainSshTerminal,
  resetPlainSshTerminalsForTests,
  resizePlainSshTerminal,
  writePlainSshTerminal,
  type PlainSshTerminalDeps
} from './plain-ssh-terminal-sessions'

const lambda: SshTarget = {
  id: 'lambda',
  label: 'lambda',
  source: 'ssh-config',
  configHost: 'lambda',
  host: 'lambda',
  port: 22,
  username: ''
}

type FakePty = {
  file: string
  args: string[]
  options: pty.IPtyForkOptions
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: (exitCode: number, signal?: number) => void
}

const spawned: FakePty[] = []

function fakeSpawn(file: string, args: string[] | string, options: pty.IPtyForkOptions): pty.IPty {
  let onData: ((data: string) => void) | null = null
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null
  const fake: FakePty = {
    file,
    args: Array.isArray(args) ? args : [args],
    options,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => fake.emitExit(129)),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData: (data) => onData?.(data),
    emitExit: (exitCode, signal) => onExit?.({ exitCode, signal })
  }
  spawned.push(fake)
  const proc = {
    cols: 80,
    rows: 24,
    write: fake.write,
    resize: fake.resize,
    kill: fake.kill,
    pause: fake.pause,
    resume: fake.resume,
    destroy: vi.fn(),
    onData: (listener: (data: string) => void) => {
      onData = listener
      return { dispose: () => {} }
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      onExit = listener
      return { dispose: () => {} }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sessions module only calls the IPty members this fake implements.
  return proc as unknown as pty.IPty
}

function deps(overrides: Partial<PlainSshTerminalDeps> = {}): PlainSshTerminalDeps {
  return {
    getTarget: (id) => (id === lambda.id ? lambda : undefined),
    isMoveBlocked: () => true,
    findSsh: () => '/usr/bin/ssh',
    mayConfigClaimAlias: () => true,
    loadPtySpawn: async () => fakeSpawn,
    homeDir: () => '/home/me',
    platform: 'linux',
    ...overrides
  }
}

function open(
  d: PlainSshTerminalDeps,
  targetId: unknown = 'lambda',
  owner = 1,
  events: PlainSshTerminalEvent[] = []
): ReturnType<typeof openPlainSshTerminal> {
  return openPlainSshTerminal(d, { targetId, cols: 100, rows: 30, owner }, (event) => {
    events.push(event)
    return true
  })
}

afterEach(async () => {
  await closeAllPlainSshTerminals()
  resetPlainSshTerminalsForTests()
  spawned.length = 0
})

describe('plain SSH terminal sessions', () => {
  it('spawns ssh itself with an argv array in the home directory, never a shell', async () => {
    const result = await open(deps())
    expect(result).toMatchObject({ ok: true, label: 'lambda' })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ file: '/usr/bin/ssh', args: ['--', 'lambda'] })
    expect(spawned[0].options).toMatchObject({ cols: 100, rows: 30, cwd: '/home/me' })
  })

  it('refuses an unknown, internal or non-string target without spawning', async () => {
    const internal: SshTarget = {
      ...lambda,
      id: 'hop',
      owner: { type: 'on-demand-runtime', runtimeId: 'r1' }
    }
    const d = deps({ getTarget: (id) => (id === 'hop' ? internal : undefined) })
    expect(await open(d, 'nope')).toEqual({ ok: false, reason: 'unknown-target' })
    expect(await open(d, 'hop')).toEqual({ ok: false, reason: 'unknown-target' })
    expect(await open(d, { id: 'lambda' })).toEqual({ ok: false, reason: 'unknown-target' })
    expect(spawned).toHaveLength(0)
  })

  it('refuses a host whose move isn’t blocked: Orca’s own terminals serve it', async () => {
    expect(await open(deps({ isMoveBlocked: () => false }))).toEqual({
      ok: false,
      reason: 'not-blocked'
    })
    expect(spawned).toHaveLength(0)
  })

  it('names OpenSSH Client when Windows has no ssh.exe, with no shell workaround', async () => {
    const result = await open(deps({ findSsh: () => null, platform: 'win32' }))
    expect(result).toMatchObject({ ok: false, reason: 'ssh-missing' })
    expect(result.ok ? '' : 'message' in result ? result.message : '').toContain('OpenSSH Client')
  })

  it('keeps one session per host across windows', async () => {
    await open(deps(), 'lambda', 1)
    expect(await open(deps(), 'lambda', 2)).toEqual({ ok: false, reason: 'already-open' })
    expect(spawned).toHaveLength(1)
  })

  it('claims the host before awaiting, so concurrent opens never spawn twice', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = deps({
      loadPtySpawn: async () => {
        await gate
        return fakeSpawn
      }
    })
    const first = open(slow, 'lambda', 1)
    const other = await open(slow, 'lambda', 2)
    // The same window replacing its own pending open (e.g. a remount) wins; the older one yields.
    const again = open(slow, 'lambda', 1)
    release()
    expect(other).toEqual({ ok: false, reason: 'already-open' })
    expect(await first).toEqual({ ok: false, reason: 'cancelled' })
    expect(await again).toMatchObject({ ok: true })
    expect(spawned).toHaveLength(1)
  })

  it('spawns nothing for an open whose window reloaded while it was pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = open(
      deps({
        loadPtySpawn: async () => {
          await gate
          return fakeSpawn
        }
      }),
      'lambda',
      3
    )
    closePlainSshTerminalsOwnedBy(3)
    release()
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' })
    expect(spawned).toHaveLength(0)
    expect(await open(deps(), 'lambda', 4)).toMatchObject({ ok: true })
  })

  it('frees the host as soon as a close is asked, before ssh has exited', async () => {
    const first = await open(deps(), 'lambda', 1)
    spawned[0].kill.mockImplementation(() => {})
    closePlainSshTerminal(first.ok ? first.sessionId : '', 1)
    expect(await open(deps(), 'lambda', 2)).toMatchObject({ ok: true })
    spawned[0].emitExit(129)
  })

  it('pauses ssh while the window has too much unrendered output, and resumes on ack', async () => {
    const result = await open(deps(), 'lambda', 1)
    const sessionId = result.ok ? result.sessionId : ''
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 8; i++) {
      spawned[0].emitData(chunk)
    }
    expect(spawned[0].pause).not.toHaveBeenCalled()
    spawned[0].emitData(chunk)
    expect(spawned[0].pause).toHaveBeenCalledTimes(1)
    // Another window's ack is ignored.
    ackPlainSshTerminal(sessionId, 2, 9 * chunk.length)
    expect(spawned[0].resume).not.toHaveBeenCalled()
    ackPlainSshTerminal(sessionId, 1, 6 * chunk.length)
    expect(spawned[0].resume).not.toHaveBeenCalled()
    ackPlainSshTerminal(sessionId, 1, 2 * chunk.length)
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
  })

  it('resumes a paused ssh before hanging up, or Windows would never report its exit', async () => {
    const result = await open(deps(), 'lambda', 1)
    const order: string[] = []
    spawned[0].resume.mockImplementation(() => order.push('resume'))
    spawned[0].kill.mockImplementation(() => order.push('kill'))
    spawned[0].emitData('x'.repeat(600 * 1024))
    expect(spawned[0].pause).toHaveBeenCalledTimes(1)
    closePlainSshTerminal(result.ok ? result.sessionId : '', 1)
    expect(order).toEqual(['resume', 'kill'])
    spawned[0].emitExit(129)
  })

  it('swallows native calls on a pty that exited but hasn’t reported it, as Windows does', async () => {
    const result = await open(deps(), 'lambda', 1)
    const sessionId = result.ok ? result.sessionId : ''
    const exited = (): never => {
      throw new Error('Cannot resize a pty that has already exited')
    }
    spawned[0].resize.mockImplementation(exited)
    spawned[0].write.mockImplementation(exited)
    expect(() => resizePlainSshTerminal(sessionId, 1, 100, 30)).not.toThrow()
    expect(() => writePlainSshTerminal(sessionId, 1, 'ls\r')).not.toThrow()
  })

  it('reports a signal kill, which is not a clean logout', async () => {
    const events: PlainSshTerminalEvent[] = []
    const result = await open(deps(), 'lambda', 1, events)
    spawned[0].emitExit(0, 9)
    expect(events).toEqual([
      { kind: 'exit', sessionId: result.ok ? result.sessionId : '', exitCode: 0, signal: 9 }
    ])
  })

  it('forwards output and exit, and only its owner can write, resize or close it', async () => {
    const events: PlainSshTerminalEvent[] = []
    const result = await open(deps(), 'lambda', 7, events)
    const sessionId = result.ok ? result.sessionId : ''
    spawned[0].emitData('Welcome to lambda\r\n')
    writePlainSshTerminal(sessionId, 8, 'rm -rf /\r')
    resizePlainSshTerminal(sessionId, 8, 10, 10)
    closePlainSshTerminal(sessionId, 8)
    expect(spawned[0].write).not.toHaveBeenCalled()
    expect(spawned[0].resize).not.toHaveBeenCalled()
    expect(spawned[0].kill).not.toHaveBeenCalled()
    writePlainSshTerminal(sessionId, 7, 'ls\r')
    resizePlainSshTerminal(sessionId, 7, 120, 40)
    expect(spawned[0].write).toHaveBeenCalledWith('ls\r')
    expect(spawned[0].resize).toHaveBeenCalledWith(120, 40)
    closePlainSshTerminal(sessionId, 7)
    expect(events).toEqual([
      { kind: 'data', sessionId, data: 'Welcome to lambda\r\n' },
      { kind: 'exit', sessionId, exitCode: 129 }
    ])
    // Ended: a new one may open.
    expect(await open(deps(), 'lambda', 7)).toMatchObject({ ok: true })
  })

  it('on quit, hangs up every session, waits for it to exit, and opens no more', async () => {
    await open(deps())
    spawned[0].kill.mockImplementation(() => {})
    let done = false
    const quit = closeAllPlainSshTerminals().then(() => {
      done = true
    })
    expect(spawned[0].kill).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(done).toBe(false)
    spawned[0].emitExit(129)
    await quit
    expect(await open(deps(), 'lambda', 9)).toEqual({ ok: false, reason: 'cancelled' })
  })
})
