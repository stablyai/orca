import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerTerminal } = await import('./structured-worker-terminal-read')
const { OrcaRuntimeWithResolveTerminalPane } =
  await import('./terminal/recovery/resolve-terminal-pane')
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
  lease?: Pick<AgentSessionLease, 'runtimeKind' | 'claimStatus'>
  hasSession?: boolean
}): void {
  const lease = options.lease ?? { runtimeKind: 'native', claimStatus: 'live' }
  hostRef.current = {
    deps: {
      store: {
        getConversation: (sessionId: string) =>
          agentSessionConversationView(
            agentSessionRecordFixture(
              agentSessionLeaseFixture({
                ...lease,
                sessionId,
                runtimeFence: 1,
                deathEvidence: null
              })
            )
          )
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

  it('serves the journal as terminal lines, with no dispatch and no capability', async () => {
    // Peers lack the coordinator/Dispatch authority worker-read requires; terminal read must still serve structured worker output.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'first line\nsecond line'), message('i2', 'done')] })
    const read = await readStructuredWorkerTerminal({ handle, db: null })
    expect(read?.tail).toEqual(['[assistant] first line', 'second line', '[assistant] done'])
    expect(read?.status).toBe('running')
    expect(read?.truncated).toBe(false)
  })

  it('honours limit, and claims no cursor space it cannot honour', async () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'a'), message('i2', 'b'), message('i3', 'c')] })
    const read = await readStructuredWorkerTerminal({ handle, db: null, limit: 2 })
    expect(read?.tail).toEqual(['[assistant] b', '[assistant] c'])
    // A sliding mutable tail cannot advertise stable cursor positions.
    expect(read?.nextCursor).toBeNull()
    expect(read?.oldestCursor).toBeUndefined()
    expect(read?.latestCursor).toBeUndefined()
  })

  it('refuses a cursor read rather than silently misdelivering lines', async () => {
    // PTY cursors index append-only lines; reprojected mutable windows could return different lines at the same index without truncated.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'a')] })
    const refusal = await readStructuredWorkerTerminal({ handle, db: null, cursor: 0 }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    expect(refusal).toMatch(/not line-addressable/)
    // Polling and diffing the bounded tail permits harmless rereads instead of silent cursor holes.
    expect(refusal).toMatch(/poll it and diff/)
    // Do not redirect peers to worker-read: it requires coordinator authority and offers no stable cursor either.
    expect(refusal).not.toContain('worker-read')
  })

  it('redacts dispatch capability tokens the same way the archive path does', async () => {
    const handle = registerWorker()
    const token = `dcap_${'a'.repeat(32)}`
    installHost({ items: [message('i1', `token is ${token} here`)] })
    const tail = (await readStructuredWorkerTerminal({ handle, db: null }))?.tail.join('\n') ?? ''
    expect(tail).not.toContain(token)
    expect(tail).toContain('[dispatch capability redacted]')
  })

  it('refuses when the session is not attached rather than answering an empty tail', async () => {
    // Unreadable history must refuse; an empty tail would falsely report silence.
    const handle = registerWorker()
    installHost({ items: 'unreadable' })
    await expect(readStructuredWorkerTerminal({ handle, db: null })).rejects.toThrow(
      'agent_session_ownership_unknown'
    )
  })

  it('reports a session it cannot verify as unknown, never as running', async () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'said something')], hasSession: false })
    expect((await readStructuredWorkerTerminal({ handle, db: null }))?.status).toBe('unknown')
  })

  it('is what `terminal read` answers with, ahead of the PTY lookup', async () => {
    // Exercise the production runtime method so missing routing cannot hide behind a correct standalone reader.
    const handle = registerWorker()
    installHost({ items: [message('i1', 'hello')] })
    const runtime: {
      readTerminal: (
        handle: string,
        opts?: { cursor?: number; limit?: number; screen?: boolean }
      ) => Promise<{ tail: string[] }>
    } = Object.assign(Object.create(OrcaRuntimeWithResolveTerminalPane.prototype), {
      getOrchestrationDbIfAvailable: () => null,
      getLivePtyForHandle: () => {
        throw new Error('the PTY lookup must never be reached for a structured worker')
      }
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      tail: ['[assistant] hello'],
      source: 'stream'
    })
    await expect(runtime.readTerminal(handle, { screen: true })).resolves.toMatchObject({
      source: 'screen-unavailable'
    })
  })

  it('leaves every handle that is not a live structured worker to the PTY path', async () => {
    const handle = registerWorker()
    installHost({ items: [message('i1', 'x')] })
    expect(await readStructuredWorkerTerminal({ handle: 'term_abc', db: null })).toBeNull()
    // A terminal owner an older build recorded loads conflicted: not this runtime's worker.
    installHost({
      items: [message('i1', 'x')],
      lease: { runtimeKind: 'native', claimStatus: 'conflicted' }
    })
    expect(await readStructuredWorkerTerminal({ handle, db: null })).toBeNull()
  })
})
