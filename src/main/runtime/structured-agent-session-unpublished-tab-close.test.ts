// A restored chat the renderer shows from its saved session before the host has listed it: the
// user can close it, and that close has to reach the durable index or the next listing revives it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

type RuntimeInternals = {
  hasPersistedStructuredAgentSessionStore(): boolean
  ensureStructuredAgentSessionHost(): Promise<void>
}

/** A host installed only when something asks for it, with one chat record in `workspace-1`. */
function runtimeInstallingHost(listed: readonly string[]) {
  const setSessionTabVisibility = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  const internal = runtime as unknown as RuntimeInternals
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.ensureStructuredAgentSessionHost = async () => {
    const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'kept' }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      deps: {
        store: {
          getRecord: (sessionId: string) =>
            sessionId === 'kept'
              ? { ...record, location: { ...record.location, workspaceId: 'workspace-1' } }
              : null
        }
      },
      listVisibleSessionIds: () => [...listed],
      setSessionTabVisibility,
      close
    } as never)
  }
  return { runtime, setSessionTabVisibility, close }
}

describe('closing a restored chat before its tab is listed', () => {
  it('installs the host and retires the chat from the durable index', async () => {
    const { runtime, setSessionTabVisibility, close } = runtimeInstallingHost(['kept'])

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:kept', { reason: 'user' })

    expect(setSessionTabVisibility).toHaveBeenCalledWith('kept', false)
    expect(close).toHaveBeenCalledWith('kept')
  })

  it.each([
    ['names another workspace', 'workspace-2', ['kept']],
    ['addresses a chat whose tab is already closed', 'workspace-1', []]
  ])(
    'refuses an unlisted chat close that %s, as for any unknown tab',
    async (_case, worktreeId, listed) => {
      const { runtime, setSessionTabVisibility, close } = runtimeInstallingHost(listed)

      await expect(
        runtime.closeMobileSessionTab(`id:${worktreeId}`, 'agent-session:kept', { reason: 'user' })
      ).rejects.toThrow('tab_not_found')

      expect(setSessionTabVisibility).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
    }
  )
})
