import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

const SHELL_PID = 4242
const IDENTITY = `\x1b]777;orca-shell-start:${SHELL_PID}\x07`
const READY = '\x1b]777;orca-shell-ready\x07'

function createBarrier(foreground: { group: number | null; name: string | null }) {
  const writes: string[] = []
  const subprocess = {
    pid: SHELL_PID,
    shellPath: '/bin/zsh',
    readForegroundGroup: () => foreground.group,
    getForegroundProcess: () => foreground.name,
    write: (data: string) => writes.push(data)
  } as unknown as SubprocessHandle
  const barrier = new SessionShellReadyBarrier({
    sessionId: 'session-1',
    subprocess,
    responderParser: {
      registerCsiHandler: () => ({ dispose: () => {} })
    } as unknown as ConstructorParameters<typeof SessionShellReadyBarrier>[0]['responderParser'],
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
    barrier.setExecFallback(() => 'claude\r')
    barrier.ingestSubprocessData(IDENTITY)
    // .zshrc ran `exec tmux`: same pid and process group, new program.
    foreground.name = 'tmux'

    vi.advanceTimersByTime(1_000)

    expect(writes).toEqual(['claude\r'])
  })

  it('leaves the command to the wrapper while zsh still owns the terminal', () => {
    const { barrier, writes } = createBarrier({
      group: SHELL_PID,
      name: 'zsh'
    })
    barrier.setExecFallback(() => 'claude\r')
    barrier.ingestSubprocessData(IDENTITY)

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
