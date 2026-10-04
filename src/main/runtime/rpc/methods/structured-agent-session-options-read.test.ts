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
})
