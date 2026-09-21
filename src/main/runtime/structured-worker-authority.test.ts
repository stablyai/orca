import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { resolveStructuredWorkerIdentity, structuredWorkerAgent } =
  await import('./structured-worker-authority')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function installRecordProvider(provider: 'claude' | 'codex' | null): void {
  hostRef.current = {
    deps: { store: { getRecord: () => (provider ? { provider } : null) } }
  }
}

/** The durable worker-terminal row is all a restarted runtime has; it carries no provider. */
function durableRow(handle: string): {
  terminal_handle: string
  pane_key: string
  process_incarnation: string
  worktree_id: string
  host_scope: string
} {
  return {
    terminal_handle: handle,
    pane_key: mintStructuredWorkerPaneKey(SESSION_ID),
    process_incarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktree_id: 'wt_1',
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
  }
}

function rehydratedIdentity(): NonNullable<ReturnType<typeof resolveStructuredWorkerIdentity>> {
  const handle = mintStructuredWorkerHandle()
  const row = durableRow(handle)
  const identity = resolveStructuredWorkerIdentity(handle, {
    getWorkerTerminalResourceByHandle: () => row
  } as never)
  if (!identity) {
    throw new Error('the durable row should rehydrate')
  }
  return identity
}

describe('structuredWorkerAgent', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('reads a rehydrated worker provider off the durable record', () => {
    installRecordProvider('codex')
    const identity = rehydratedIdentity()
    expect(identity.agent).toBeNull()
    // Defaulting here is what stamped a restarted Codex worker's frozen archive as Claude.
    expect(structuredWorkerAgent(identity)).toBe('codex')
  })

  it('keeps the provider this process registered, without consulting the record', () => {
    installRecordProvider('claude')
    const handle = mintStructuredWorkerHandle()
    const identity = structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_ID,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    expect(structuredWorkerAgent(identity)).toBe('codex')
  })

  it('falls back to claude only when no record can name the provider', () => {
    installRecordProvider(null)
    expect(structuredWorkerAgent(rehydratedIdentity())).toBe('claude')
  })
})
