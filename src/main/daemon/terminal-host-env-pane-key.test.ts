import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

const SPAWN_PANE = 'tab-old:11111111-1111-4111-8111-111111111111'
const LATER_PANE = 'tab-new:22222222-2222-4222-8222-222222222222'

function createSubprocess(): SubprocessHandle & { exit: () => void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_998,
    getForegroundProcess: () => 'zsh',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    exit: () => onExit?.(0)
  }
}

describe('TerminalHost records the pane key it exported into each PTY', () => {
  const subprocesses: ReturnType<typeof createSubprocess>[] = []
  const host = new TerminalHost({
    spawnSubprocess: () => {
      const handle = createSubprocess()
      subprocesses.push(handle)
      return handle
    }
  })

  afterEach(() => {
    for (const handle of subprocesses.splice(0)) {
      handle.exit()
    }
  })

  it('lists the spawn-time key, which a later attach cannot change', async () => {
    const streamClient = { onData: vi.fn(), onExit: vi.fn() }
    await host.createOrAttach({
      sessionId: 'surviving-shell',
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: SPAWN_PANE, ORCA_TERMINAL_HANDLE: 'term_surviving' },
      streamClient
    })
    // A relaunched app reattaches from its new pane; the live process's environment is unchanged.
    const reattached = await host.createOrAttach({
      sessionId: 'surviving-shell',
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: LATER_PANE },
      streamClient
    })

    expect(reattached.isNew).toBe(false)
    expect(host.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'surviving-shell',
        terminalHandle: 'term_surviving',
        envPaneKey: SPAWN_PANE
      })
    ])
  })

  it('omits the field for a shell spawned without a pane', async () => {
    await host.createOrAttach({
      sessionId: 'bare-shell',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(
      host.listSessions().find(({ sessionId }) => sessionId === 'bare-shell')
    ).not.toHaveProperty('envPaneKey')
  })
})
