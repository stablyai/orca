import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerTerminal } = await import('./structured-worker-terminal-read')
const { OrcaRuntimeWithResolveTerminalPane } = await import('./orca-runtime-resolve-terminal-pane')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function message(id: string, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  } as unknown as AgentJournalRenderItem
}

function installHost(options: {
  items?: readonly AgentJournalRenderItem[] | 'unreadable'
  hasOlder?: boolean
  lease?: { runtimeKind: string; claimStatus: string }
  hasSession?: boolean
}): void {
  const lease = options.lease ?? { runtimeKind: 'native', claimStatus: 'live' }
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          ({
            sessionId,
            location: { executionHostId: 'local', wslDistro: null },
            lease: { ...lease, runtimeFence: 1, deathEvidence: null }
          }) as unknown as AgentSessionRecord
      }
    },
    hasSession: () => options.hasSession ?? true,
    history: () => {
      if (options.items === 'unreadable') {
        throw new Error('agent_session_ownership_unknown')
      }
      return { page: { items: options.items ?? [], hasOlder: options.hasOlder ?? false } }
    }
  }
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

describe('reading a structured worker through the terminal-read path', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('serves the journal as terminal lines, with no dispatch and no capability', () => {
    // The defect this pins: a peer has no dispatch id and no coordinator standing, so `worker-read`
    // is closed to it, and `terminal read` threw `terminal_handle_stale` for a perfectly live
    // worker. A peer could not see a structured agent's recent output at all.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'first line\nsecond line'), message('i2', 'done')] })
    const read = readStructuredWorkerTerminal({ handle, db: null })
    expect(read?.tail).toEqual(['[assistant] first line', 'second line', '[assistant] done'])
    expect(read?.status).toBe('running')
    expect(read?.truncated).toBe(false)
  })

  it('honours limit, and claims no cursor space it cannot honour', () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'a'), message('i2', 'b'), message('i3', 'c')] })
    const read = readStructuredWorkerTerminal({ handle, db: null, limit: 2 })
    expect(read?.tail).toEqual(['[assistant] b', '[assistant] c'])
    // No index is advertised: the next read re-projects a sliding window, so 0/length would name
    // positions that address different lines by then.
    expect(read?.nextCursor).toBeNull()
    expect(read?.oldestCursor).toBeUndefined()
    expect(read?.latestCursor).toBeUndefined()
  })

  it('refuses a cursor read rather than silently misdelivering lines', () => {
    // The PTY cursor indexes an append-only completed-line buffer with a monotone count. This
    // window is a bounded tail re-projected every read, so a saved index addresses different lines
    // as the journal grows — and `truncated` could never fire to say so, because it tests
    // `cursor < oldestCursor` and `oldestCursor` was always 0. A poller would get wrong or
    // duplicated lines with `truncated:false`.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'a')] })
    const refusal = (() => {
      try {
        readStructuredWorkerTerminal({ handle, db: null, cursor: 0 })
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(refusal).toMatch(/not line-addressable/)
    // Tells the caller what DOES work here. Polling a bounded newest-last tail and diffing fails
    // safe — a harmless re-read — where a broken cursor fails unsafe, as a silent hole.
    expect(refusal).toMatch(/poll it and diff/)
    // And names no paging alternative, because there is none. It must never send a peer to
    // `worker-read`: that verb needs a dispatch id and coordinator standing this caller does not
    // have, and it is a window index over the same bounded page rather than an append-only anchor.
    expect(refusal).not.toContain('worker-read')
  })

  it('reports dropped history as truncated rather than pretending the page is whole', () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'tail only')], hasOlder: true })
    expect(readStructuredWorkerTerminal({ handle, db: null })?.truncated).toBe(true)
  })

  it('redacts dispatch capability tokens the same way the archive path does', () => {
    const handle = registerWorker()
    const token = `dcap_${'a'.repeat(32)}`
    installHost({ items: [message('i1', `token is ${token} here`)] })
    const tail = readStructuredWorkerTerminal({ handle, db: null })?.tail.join('\n') ?? ''
    expect(tail).not.toContain(token)
    expect(tail).toContain('[dispatch capability redacted]')
  })

  it('refuses when the session is not attached rather than answering an empty tail', () => {
    // An empty tail is the claim "this worker has produced no output", which is a different and
    // false statement — and the one a caller cannot tell apart from a real silence.
    const handle = registerWorker()
    installHost({ items: 'unreadable' })
    expect(() => readStructuredWorkerTerminal({ handle, db: null })).toThrow(
      'agent_session_ownership_unknown'
    )
  })

  it('reports a session it cannot verify as unknown, never as running', () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'said something')], hasSession: false })
    expect(readStructuredWorkerTerminal({ handle, db: null })?.status).toBe('unknown')
  })

  it('is what `terminal read` answers with, ahead of the PTY lookup', async () => {
    // The real method through the real prototype, because the wiring IS the fix: the module below
    // could be perfect and a peer would still get `terminal_handle_stale` if nothing called it.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'hello')] })
    const runtime = Object.assign(Object.create(OrcaRuntimeWithResolveTerminalPane.prototype), {
      getOrchestrationDbIfAvailable: () => null,
      getLivePtyForHandle: () => {
        throw new Error('the PTY lookup must never be reached for a structured worker')
      }
    }) as { readTerminal: (handle: string, opts?: object) => Promise<{ tail: string[] }> }
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      tail: ['[assistant] hello'],
      source: 'stream'
    })
    // There is no rendered grid to screenshot, and saying so beats inventing one.
    await expect(runtime.readTerminal(handle, { screen: true })).resolves.toMatchObject({
      source: 'screen-unavailable'
    })
  })

  it('leaves every handle that is not a live structured worker to the PTY path', () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'x')] })
    expect(readStructuredWorkerTerminal({ handle: 'term_abc', db: null })).toBeNull()
    // A lease handed to a TUI owner is no longer this runtime's structured worker.
    installHost({ items: [message('i1', 'x')], lease: { runtimeKind: 'tui', claimStatus: 'live' } })
    expect(readStructuredWorkerTerminal({ handle, db: null })).toBeNull()
  })
})
