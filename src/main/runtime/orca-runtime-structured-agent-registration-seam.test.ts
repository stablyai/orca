// createSupport, create and the model catalog's account read ask the runtime's one registration
// list where an agent runs and which account it pins, before any host exists. An agent the list does
// not hold is answered no without installing the host.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'

afterEach(() => vi.restoreAllMocks())

const LOCAL = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree' as const
}

function runtimeAt(location = LOCAL) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these reads consume only getSettings from the store.
    { getSettings: () => ({ agentDefaultEnv: {} }) } as never
  )
  const installHost = vi.fn(async () => {
    throw new Error('the host must not be installed to answer this')
  })
  Object.assign(runtime, {
    resolveStructuredAgentSessionLocation: vi.fn(async () => location),
    ensureStructuredAgentSessionHost: installHost
  })
  return { runtime, installHost }
}

describe('the structured agent registration list', () => {
  it("answers createSupport from the agent's own location rule", async () => {
    const codex = structuredAgentRuntimeRegistration('codex')!
    const { runtime, installHost } = runtimeAt()
    expect(await runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')).toEqual(
      { supported: true }
    )

    vi.spyOn(codex, 'supportsLocation').mockReturnValue(false)
    expect(await runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')).toEqual(
      { supported: false, reason: 'agent' }
    )
    expect(codex.supportsLocation).toHaveBeenCalledWith(LOCAL)
    expect(installHost).not.toHaveBeenCalled()
  })

  it('refuses an agent it does not hold without installing the host', async () => {
    const { runtime, installHost } = runtimeAt()
    // No structured registration exists for Cursor.
    expect(
      await runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'cursor')
    ).toEqual({
      supported: false,
      reason: 'agent'
    })
    await expect(runtime.resolveStructuredAgentAccountHome('cursor')).rejects.toMatchObject({
      message: 'structured_agent_session_unsupported'
    })
    expect(installHost).not.toHaveBeenCalled()
  })

  it("resolves an account home through the agent's registration, with the read purpose", async () => {
    const claude = structuredAgentRuntimeRegistration('claude')!
    vi.spyOn(claude, 'resolveAccountHome').mockResolvedValue({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/claude'
    })
    const { runtime, installHost } = runtimeAt()

    expect(await runtime.resolveStructuredAgentAccountHome('claude')).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/claude'
    })
    expect(claude.resolveAccountHome).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'read', location: null, workspacePath: null }),
      expect.anything()
    )
    expect(installHost).not.toHaveBeenCalled()
  })
})
