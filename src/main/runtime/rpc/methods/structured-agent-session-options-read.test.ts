// The catalog read behind the picker: which directory a named worktree runs in on this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.modelCatalog', () => {
  const read = vi.fn(async () => ({ origin: 'unknown' as const }))

  beforeEach(() => {
    read.mockClear()
    setStructuredAgentSessionHost(Object.assign(hostStub(), { deps: { modelCatalog: { read } } }))
  })

  it('reads the catalog for the directory the named worktree runs in on this host', async () => {
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/repo/wt')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: 'id:wt-1' },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).toHaveBeenCalledWith('id:wt-1')
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspacePath: '/repo/wt'
    })
  })

  it('reads for an unplaced workspace when the worktree does not resolve', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', worktree: 'id:missing' },
      STRUCTURED_CLIENT,
      {
        resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => {
          throw new Error('selector_not_found')
        })
      }
    )
    expect(read).toHaveBeenCalledWith({ agent: 'codex', workspacePath: null })
  })

  it('reads as before when no worktree is named', async () => {
    await call('agentSession.modelCatalog', { agent: 'claude' }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'claude' })
  })

  it('passes a wait for the listing through to the catalog', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, waitForListing: true },
      STRUCTURED_CLIENT
    )
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION, waitForListing: true })
  })
})

describe('agentSession.modelCatalog before anything built the host', () => {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
    fetchedAt: 1
  }))
  const installHost = vi.fn(async () => {
    setStructuredAgentSessionHost(Object.assign(hostStub(), { deps: { modelCatalog: { read } } }))
  })

  beforeEach(() => {
    read.mockClear()
    installHost.mockClear()
    clearStructuredHostStub()
  })

  // A new chat's picker reads before its create lands; on a host with no saved chats nothing else
  // has built the host yet, and a refusal here left the picker on the client's built-in list.
  it('builds the host for a structured chat and answers from its catalog', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      STRUCTURED_CLIENT,
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).toHaveBeenCalledTimes(1)
    expect(reply).toMatchObject({ ok: true, result: { origin: 'probe' } })
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION })
  })

  // Terminal-backed chat reads with no session: a host that runs no structured chat keeps its
  // journal closed, and the read falls back to the CLI listing.
  it('does not build the host for a read that names no session', async () => {
    const reply = await call('agentSession.modelCatalog', { agent: 'codex' }, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost: installHost
    })
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()
  })

  it('does not build the host for a client that cannot read structured sessions', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] },
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: false })
  })
})
