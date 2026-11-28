import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../emulation/headless-emulator'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

const SHELL_PID = 4242
const IDENTITY = `\x1b]777;orca-shell-start:${SHELL_PID}\x07`
const READY = '\x1b]777;orca-shell-ready\x07'

function createBarrier(foreground: { group: number | null; name: string | null }) {
  const writes: string[] = []
  const subprocess: SubprocessHandle = {
    pid: SHELL_PID,
    shellPath: '/bin/zsh',
    readForegroundGroup: () => foreground.group,
    getForegroundProcess: () => foreground.name,
    write: (data) => {
      writes.push(data)
    },
    resize: () => {},
    kill: () => {},
    forceKill: () => {},
    terminateOwnedTree: () => 'unavailable',
    signal: () => {},
    onData: () => {},
    onExit: () => {},
    dispose: () => {}
  }
  const barrier = new SessionShellReadyBarrier({
    sessionId: 'session-1',
    subprocess,
    responderParser: new HeadlessEmulator({ cols: 80, rows: 24 }).responderParser,
    shellReadySupported: true,
    shellReadyTimeoutMs: 1_000,
    installDeviceAttributesFilter: () => {},
    releaseDeviceAttributesFilter: () => {},
    acceptStartupIngress: () => {}
  })
  return { barrier, writes }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('wrapper-delivered startup command fallback', () => {
  it('types the command at ready timeout when zsh exec-ed into another program', () => {
    const foreground = { group: SHELL_PID, name: 'zsh' }
    const { barrier, writes } = createBarrier(foreground)
    const build = vi.fn(() => 'claude\r')
    barrier.setExecFallback(build)
    barrier.ingestSubprocessData(IDENTITY)
    // .zshrc ran `exec fish`: same pid and process group, new program.
    foreground.name = '-fish'

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual(['claude\r'])
    expect(build).toHaveBeenCalledWith('fish')
  })

  it('clears a line the user typed into the replacing shell before typing the command', () => {
    const foreground = { group: SHELL_PID, name: 'zsh' }
    const { barrier, writes } = createBarrier(foreground)
    barrier.setExecFallback(() => 'claude\r')
    barrier.ingestSubprocessData(IDENTITY)
    barrier.observeTypedInput('echo pending')
    foreground.name = 'bash'

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual([' \x15claude\r'])
  })

  it('leaves the command to the wrapper while zsh still owns the terminal', () => {
    const { barrier, writes } = createBarrier({
      group: SHELL_PID,
      name: 'zsh'
    })
    barrier.setExecFallback(() => 'claude\r')
    barrier.ingestSubprocessData(IDENTITY)
    // Input for the rc file's own question stays where the user typed it.
    barrier.observeTypedInput('y')

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual([])
  })

  it('leaves the command to the wrapper while an rc file runs a foreground child', () => {
    const { barrier, writes } = createBarrier({
      group: SHELL_PID + 1,
      name: 'brew'
    })
    barrier.setExecFallback(() => 'claude\r')
    barrier.ingestSubprocessData(IDENTITY)

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual([])
  })

  it('never types the command once the wrapper reached its line editor', () => {
    const foreground = { group: SHELL_PID, name: 'zsh' }
    const { barrier, writes } = createBarrier(foreground)
    const build = vi.fn(() => 'claude\r')
    barrier.setExecFallback(build)
    barrier.ingestSubprocessData(`${IDENTITY}${READY}`)
    foreground.name = 'claude'

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual([])
    expect(build).not.toHaveBeenCalled()
  })
})
