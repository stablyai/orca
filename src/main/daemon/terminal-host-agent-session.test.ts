import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

function createClaimedSubprocess(): SubprocessHandle & {
  emitData: (data: string) => void
  exit: () => void
} {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: () => 'codex',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: (listener) => {
      onData = listener
    },
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    emitData: (data) => onData?.(data),
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

  it('cannot adopt a live session that predates provider-session claims', async () => {
    const subprocesses: ReturnType<typeof createClaimedSubprocess>[] = []
    host = new TerminalHost({
      spawnSubprocess: () => {
        const handle = createClaimedSubprocess()
        subprocesses.push(handle)
        return handle
      }
    })
    await host.createOrAttach({
      sessionId: 'renderer-owned-live-session',
      cols: 80,
      rows: 24,
      launchAgent: 'codex',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    const resumed = await host.createOrAttach({
      sessionId: 'replacement-resume-session',
      cols: 80,
      rows: 24,
      launchAgent: 'codex',
      streamClient: { onData: vi.fn(), onExit: vi.fn() },
      agentSessionEnsure: { claim, surface }
    })

    expect(resumed.agentSessionEnsure?.disposition).toBe('created')
    expect(
      host
        .listSessions()
        .map(({ sessionId }) => sessionId)
        .sort()
    ).toEqual(['renderer-owned-live-session', 'replacement-resume-session'])
    expect(subprocesses).toHaveLength(2)
    host.write('renderer-owned-live-session', 'original-writer')
    host.write('replacement-resume-session', 'replacement-writer')
    expect(subprocesses[0]?.write).toHaveBeenCalledWith('original-writer')
    expect(subprocesses[1]?.write).toHaveBeenCalledWith('replacement-writer')
    for (const handle of subprocesses) {
      handle.exit()
    }
  })

  it('rejects a competing claim without replacing the winning stream', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        subprocess = createClaimedSubprocess()
        return subprocess
      }
    })
    const winningData = vi.fn()
    const competingData = vi.fn()

    const winning = host.createOrAttach({
      sessionId: 'shared-requested-id',
      cols: 80,
      rows: 24,
      streamClient: { onData: winningData, onExit: vi.fn() },
      agentSessionEnsure: { claim, surface }
    })
    const competing = host.createOrAttach({
      sessionId: 'shared-requested-id',
      cols: 80,
      rows: 24,
      streamClient: { onData: competingData, onExit: vi.fn() },
      agentSessionEnsure: {
        claim: {
          ...claim,
          keyId: 'other-key',
          identityDigest: 'ccccccccccccccccccccccccccccccccccccccccccc'
        },
        surface: { ...surface, terminalHandle: 'term_competing' }
      }
    })

    releaseSpawn()
    await expect(winning).resolves.toMatchObject({ isNew: true })
    await expect(competing).rejects.toThrow('agent_session_claim_unavailable')

    subprocess?.emitData('winner-only')
    expect(winningData).toHaveBeenCalledExactlyOnceWith('winner-only')
    expect(competingData).not.toHaveBeenCalled()
  })

  it('does not attach a canceled adopter after waiting for a reservation', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        subprocess = createClaimedSubprocess()
        return subprocess
      }
    })
    const winningData = vi.fn()
    const canceledData = vi.fn()
    let canceled = false

    const winning = host.createOrAttach({
      sessionId: 'reservation-owner',
      cols: 80,
      rows: 24,
      streamClient: { onData: winningData, onExit: vi.fn() },
      agentSessionEnsure: { claim, surface }
    })
    const adopter = host.createOrAttach({
      sessionId: 'reservation-adopter',
      cols: 80,
      rows: 24,
      streamClient: { onData: canceledData, onExit: vi.fn() },
      agentSessionEnsure: { claim, surface },
      isCanceled: () => canceled
    })

    canceled = true
    releaseSpawn()
    await expect(winning).resolves.toMatchObject({ isNew: true })
    await expect(adopter).rejects.toThrow('Attach canceled for session reservation-owner')

    subprocess?.emitData('winner-only')
    expect(winningData).toHaveBeenCalledExactlyOnceWith('winner-only')
    expect(canceledData).not.toHaveBeenCalled()
  })
})
