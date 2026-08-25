import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

type TestSubprocess = SubprocessHandle & {
  emitData: (data: string) => void
  emitExit: (code: number) => void
}

function createSubprocess(): TestSubprocess {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData: (data) => onData?.(data),
    emitExit: (code) => onExit?.(code)
  } as TestSubprocess
}

type SpawnSubprocess = (options: {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  launchAgent?: TuiAgent
}) => SubprocessHandle

describe('TerminalHost incarnation fencing', () => {
  let host: TerminalHost
  let subprocess: TestSubprocess

  beforeEach(() => {
    subprocess = createSubprocess()
    const spawnSubprocess = vi.fn(() => subprocess) as SpawnSubprocess
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('attaches only when the expected session incarnation matches', async () => {
    const created = await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    const attached = await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      attachOnly: true,
      expectedIncarnationId: created.incarnationId,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(attached.incarnationId).toBe(created.incarnationId)
    expect(attached.isNew).toBe(false)
  })

  it('rejects stale identity before snapshot or client attachment side effects', async () => {
    const initialClient = { onData: vi.fn(), onExit: vi.fn() }
    await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: initialClient
    })
    const session = (host as unknown as { sessions: Map<string, Session> }).sessions.get(
      'session-1'
    )!
    const getSnapshot = vi.spyOn(session, 'getSnapshot')
    const detachAllClients = vi.spyOn(session, 'detachAllClients')
    const attachClient = vi.spyOn(session, 'attachClient')
    const staleClient = { onData: vi.fn(), onExit: vi.fn() }

    await expect(
      host.createOrAttach({
        sessionId: 'session-1',
        cols: 80,
        rows: 24,
        attachOnly: true,
        expectedIncarnationId: 'stale-incarnation',
        streamClient: staleClient
      })
    ).rejects.toThrow('Session not found: session-1')

    expect(getSnapshot).not.toHaveBeenCalled()
    expect(detachAllClients).not.toHaveBeenCalled()
    expect(attachClient).not.toHaveBeenCalled()
    subprocess.emitData('still-owned-by-current-client')
    expect(initialClient.onData).toHaveBeenCalledWith('still-owned-by-current-client')
    expect(staleClient.onData).not.toHaveBeenCalled()
  })

  it('rejects stale writes and resizes before reaching a replacement session', async () => {
    const created = await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(() => host.write('session-1', 'stale', 'old-incarnation')).toThrow()
    expect(subprocess.write).not.toHaveBeenCalled()
    expect(() => host.resize('session-1', 120, 40, 'old-incarnation')).toThrow()
    expect(subprocess.resize).not.toHaveBeenCalled()
    host.write('session-1', 'current', created.incarnationId)
    host.resize('session-1', 120, 40, created.incarnationId)
    expect(subprocess.write).toHaveBeenCalledWith('current')
    expect(subprocess.resize).toHaveBeenCalledWith(120, 40)
  })
})
