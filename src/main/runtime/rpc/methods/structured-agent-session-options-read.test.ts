// The catalog read behind the picker: which directory a named worktree runs in on this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
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
  let record: AgentSessionRecord | null = null

  beforeEach(() => {
    read.mockClear()
    record = null
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: { read }, store: { getRecord: () => record }, adapter: {} }
      })
    )
  })

  it("reads a floating chat's catalog in the folder it was created in", async () => {
    const fixture = agentSessionRecordFixture()
    record = {
      ...fixture,
      location: { ...fixture.location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: '/home/me/floating-a'
    }
    // The floating setting has since moved to another folder.
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/home/me/floating-b')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspacePath: '/home/me/floating-a'
    })
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

  it('passes a saved-only read through to the catalog', async () => {
    await call('agentSession.modelCatalog', { agent: 'grok', savedOnly: true }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'grok', savedOnly: true })
  })
})

describe('agentSession.modelCatalog before anything built the host', () => {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
    fetchedAt: 1
  }))
  const installHost = vi.fn(async () => {
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: { read }, store: { getRecord: () => null }, adapter: {} }
      })
    )
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

const PI_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
    PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY
  ]
}

describe("agentSession.modelCatalog with what the running agent's start said", () => {
  const read = vi.fn(async (): Promise<AgentSessionModelCatalogResult> => ({ origin: 'unknown' }))
  const startUnavailable = vi.fn((_sessionId: string): AgentSessionUnavailable | undefined => ({
    reason: 'notSignedIn'
  }))
  const record: AgentSessionRecord = { ...agentSessionRecordFixture(), provider: 'pi' }
  const readFor = (agent: string) =>
    call('agentSession.modelCatalog', { agent, sessionId: record.sessionId }, PI_CLIENT)

  beforeEach(() => {
    read.mockReset()
    read.mockResolvedValue({ origin: 'unknown' })
    startUnavailable.mockClear()
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: {
          modelCatalog: { read },
          store: { getRecord: () => record },
          adapter: { startUnavailable }
        }
      })
    )
  })

  it("answers a Pi chat's catalog with its signed-out start", async () => {
    const reply = await readFor('pi')
    expect(startUnavailable).toHaveBeenCalledWith(record.sessionId)
    expect(reply).toMatchObject({
      ok: true,
      result: { origin: 'unknown', unavailable: { reason: 'notSignedIn' } }
    })
  })

  it('keeps the reason the catalog itself found', async () => {
    read.mockResolvedValue({ origin: 'unknown', unavailable: { reason: 'cliMissing' } })
    expect(await readFor('pi')).toMatchObject({
      ok: true,
      result: { unavailable: { reason: 'cliMissing' } }
    })
  })

  it("never lends one agent's start to another agent's read", async () => {
    const reply = await readFor('codex')
    expect(startUnavailable).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: true, result: { origin: 'unknown' } })
    expect(reply).not.toMatchObject({ result: { unavailable: expect.anything() } })
  })

  it('stays quiet while the start said nothing', async () => {
    startUnavailable.mockReturnValueOnce(undefined)
    const reply = await readFor('pi')
    expect(reply).toMatchObject({ ok: true })
    expect(reply).not.toMatchObject({ result: { unavailable: expect.anything() } })
  })
})
