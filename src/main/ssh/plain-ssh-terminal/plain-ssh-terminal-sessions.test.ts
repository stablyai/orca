import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import type { PlainSshTerminalEvent } from '../../../shared/terminal/runtime/plain-ssh-terminal'
import {
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
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: (exitCode: number, signal?: number) => void
}

const spawned: FakePty[] = []

function fakeSpawn(): pty.IPty {
  let onData: ((data: string) => void) | null = null
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null
  const fake: FakePty = {
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
    // Same-window remount replaces its pending claim; older async open must yield.
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
