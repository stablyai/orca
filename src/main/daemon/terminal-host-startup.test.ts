import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

function mockSubprocess(): SubprocessHandle {
  return {
    pid: 1,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: () => {},
    dispose: vi.fn()
  } as SubprocessHandle
}

// Why: Windows shells (PowerShell/cmd.exe) submit on CR, not LF. Without CR
// the startup command sits typed at the prompt but unexecuted — forcing the
// user to press Enter after "claude" (or a setup script) is injected.
// POSIX shells (bash/zsh) keep the LF behaviour. A caller-supplied terminator
// must not be doubled.
describe('TerminalHost startup command terminator', () => {
  const origPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  let sub: SubprocessHandle
  let host: TerminalHost
  beforeEach(() => {
    sub = mockSubprocess()
    host = new TerminalHost({ spawnSubprocess: () => sub })
  })

  it.each([
    ['win32', 'claude', 'claude\r'],
    ['darwin', 'claude', 'claude\n'],
    ['win32', 'claude\r', 'claude\r'],
    ['darwin', 'claude\n', 'claude\n']
  ])('submits startup with correct terminator on %s', async (platform, cmd, sent) => {
    Object.defineProperty(process, 'platform', { value: platform })
    await host.createOrAttach({
      sessionId: `s-${platform}-${cmd.length}`,
      cols: 80,
      rows: 24,
      command: cmd,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(sub.write).toHaveBeenCalledWith(sent)
  })
})

// Why: a missing command and a lost one used to log identically.
describe('TerminalHost startup command delivery logging', () => {
  let sub: SubprocessHandle
  let events: { event: string; details: Record<string, unknown> }[]
  let host: TerminalHost

  beforeEach(() => {
    sub = mockSubprocess()
    events = []
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: (event, details) => events.push({ event, details })
    })
  })

  const delivery = (): Record<string, unknown> =>
    events.find((e) => e.event === 'startup-command-delivery')?.details ?? {}

  it('records a written startup command', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-written',
      cols: 80,
      rows: 24,
      command: 'codex',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(delivery()).toMatchObject({ written: true, hasCommand: true, commandLength: 5 })
  })

  it('records a session created with no startup command at all', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-none',
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(delivery()).toMatchObject({ written: false, hasCommand: false, commandLength: 0 })
    expect(sub.write).not.toHaveBeenCalled()
  })

  it('never logs the command text, which can carry credentials', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-secret',
      cols: 80,
      rows: 24,
      command: 'deploy --token=hunter2',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(JSON.stringify(delivery())).not.toContain('hunter2')
  })

  it('still delivers the command when the diagnostic sink throws', async () => {
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: () => {
        throw new Error('log sink unavailable')
      }
    })

    await expect(
      host.createOrAttach({
        sessionId: 'delivery-sink-failure',
        cols: 80,
        rows: 24,
        command: 'codex',
        shellReadySupported: false,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).resolves.toMatchObject({ isNew: true })
    expect(sub.write).toHaveBeenCalledWith(`codex${process.platform === 'win32' ? '\r' : '\n'}`)
  })
})

// Why: a command typed into wsl.exe before the distro's login shell is reading
// is dropped (#24188). The daemon learns the pane is WSL only from the spawned
// subprocess, so the wait has to switch on there, not from main's hint.
describe('TerminalHost WSL startup command', () => {
  const origPlatform = process.platform
  let emitData: (data: string) => void
  let sub: SubprocessHandle
  let host: TerminalHost

  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    emitData = () => {}
    sub = {
      ...mockSubprocess(),
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      onData: (cb: (data: string) => void) => {
        emitData = cb
      }
    }
    host = new TerminalHost({ spawnSubprocess: () => sub })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  const create = (sessionId: string): Promise<unknown> =>
    host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      command: "pi 'test'",
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

  it('holds the command until the guest shell reports ready', async () => {
    await create('wsl-ready')
    emitData('\x1b[?25l\x1b[2J')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sub.write).not.toHaveBeenCalledWith("pi 'test'\r")

    emitData('\x1b]777;orca-shell-ready\x07')
    emitData('➜  rcm ')
    await vi.advanceTimersByTimeAsync(100)
    // Raw submit: the guest may be a shell Orca does not wrap, so no bracketed paste.
    expect(sub.write).toHaveBeenCalledWith("pi 'test'\r")
  })

  it('still delivers the command when the guest never reports ready', async () => {
    await create('wsl-timeout')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sub.write).toHaveBeenCalledWith("pi 'test'\r")
  })
})
