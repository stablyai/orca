/**
 * Revealing a persisted chat, for both structured providers.
 *
 * The reveal path is the only way an Agent Session History row reaches a chat whose tab this
 * process never published — a chat closed cleanly, or one this process has not opened since
 * launch. It opens the conversation through the host's accessor and starts no agent; what it must
 * get right is which records it accepts and what it answers when the journal cannot be opened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

function recordFor(provider: 'claude' | 'codex', sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return {
    ...record,
    provider,
    providerHandleChain:
      provider === 'codex'
        ? [
            {
              ...record.providerHandleChain[0]!,
              handle: codexProviderHandle(`thread-${sessionId}`)
            }
          ]
        : record.providerHandleChain
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the host answer a client acts on', () => {
  function record(provider: 'claude' | 'codex', workspaceId: string) {
    const base = recordFor(provider, 'session-answered')
    return { ...base, location: { ...base.location, workspaceId } }
  }

  it.each(['claude', 'codex'] as const)(
    "answers a %s chat with the record's own workspace and provider, never a caller's",
    async (provider) => {
      // The security property: a client sends only a session id, so the tab cannot be aimed at
      // another workspace by asking for one.
      const stored = record(provider, 'workspace-from-record')
      const open = vi.fn(async () => undefined)

      await expect(
        revealStructuredAgentSession(
          { store: { getRecord: () => stored } },
          'session-answered',
          open
        )
      ).resolves.toEqual({
        sessionId: 'session-answered',
        workspaceId: 'workspace-from-record',
        agent: provider,
        readable: true
      })
      expect(open).toHaveBeenCalledExactlyOnceWith('session-answered')
    }
  )

  it('refuses a session this host holds no record for, opening nothing', async () => {
    const open = vi.fn(async () => undefined)
    await expect(
      revealStructuredAgentSession({ store: { getRecord: () => null } }, 'session-absent', open)
    ).rejects.toThrow('agent_session_identity_required')
    expect(open).not.toHaveBeenCalled()
  })

  it('reveals a stored chat without requiring a provider adapter', async () => {
    const open = vi.fn(async () => undefined)

    await expect(
      revealStructuredAgentSession(
        {
          store: { getRecord: () => record('codex', 'workspace-1') }
        },
        'session-answered',
        open
      )
    ).resolves.toMatchObject({ readable: true })
    expect(open).toHaveBeenCalledOnce()
  })

  it('answers not-readable without refusing when the journal could not be opened', async () => {
    // The tab is still worth publishing: the chat shows the failure and keeps retrying the read.
    await expect(
      revealStructuredAgentSession(
        {
          store: { getRecord: () => record('codex', 'workspace-1') }
        },
        'session-answered',
        async () => {
          throw new Error('journal unreadable')
        }
      )
    ).resolves.toMatchObject({ readable: false, agent: 'codex' })
  })
})
