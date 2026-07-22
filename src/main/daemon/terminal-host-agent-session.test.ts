import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session'
import { TerminalHost } from './terminal-host'

function createClaimedSubprocess(): SubprocessHandle & { exit: () => void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: () => 'codex',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    exit: () => onExit?.(0)
  }
}

describe('TerminalHost agent-session claims', () => {
  let host: TerminalHost
  let subprocess: ReturnType<typeof createClaimedSubprocess> | undefined
  const spawnSubprocess = vi.fn(() => {
    subprocess = createClaimedSubprocess()
    return subprocess
  })
  const claim = {
    digestVersion: 1 as const,
    keyId: 'key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'codex' as const
  }
  const surface = {
    worktreeId: 'worktree',
    tabId: 'tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminalHandle: 'term_claimed'
  }

  beforeEach(() => {
    spawnSubprocess.mockClear()
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    subprocess?.exit()
    await host.dispose()
  })

  it('adopts one claimed provider session across different requested daemon ids', async () => {
    const first = await host.createOrAttach({
      sessionId: 'session-claimed-first',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() },
      agentSessionEnsure: { claim, surface }
    })
    const second = await host.createOrAttach({
      sessionId: 'session-claimed-retry',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() },
      agentSessionEnsure: {
        claim,
        surface: { ...surface, terminalHandle: 'term_retry' }
      }
    })

    expect(first.agentSessionEnsure).toMatchObject({
      disposition: 'created',
      owner: { ptyId: 'session-claimed-first', surface }
    })
    expect(second.agentSessionEnsure).toMatchObject({
      disposition: 'adopted',
      owner: { ptyId: 'session-claimed-first', surface }
    })
    expect(spawnSubprocess).toHaveBeenCalledOnce()
  })
})
