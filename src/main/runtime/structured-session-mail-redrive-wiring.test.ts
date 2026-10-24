import { holdInFlightWorktreeCreate } from '../worktree-create-in-flight'
// The production wiring of the idle-edge mail redrive: the host the runtime installs must report
// every status change to the runtime's mail redrive. The integration test installs its own callback,
// so without this nothing pins the line that connects the two in the real app.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type * as StructuredAgentSessionRuntime from './structured-agent-session-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

const installed = vi.hoisted((): { deps: StructuredAgentSessionRuntimeDeps | null } => ({
  deps: null
}))

vi.mock('./structured-agent-session-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentSessionRuntime>()),
  ensureStructuredAgentSessionHost: vi.fn(async (deps: StructuredAgentSessionRuntimeDeps) => {
    installed.deps = deps
    return {}
  })
}))

const { OrcaRuntimeService } = await import('./orca-runtime')
const { OrchestrationDb } = await import('./orchestration/db')

describe("the runtime's own structured host install", () => {
  it('makes raw recorded locations join preparation and then the actual prepared setup hold', async () => {
    const runtime = new OrcaRuntimeService()
    await runtime.ensureStructuredAgentSessionHost()
    const workspaceId = 'repo-setup::/tmp/orca-31255-preparing'
    const setupHold = installed.deps?.setupHold
    if (!setupHold) {
      throw new Error('missing setup admission')
    }
    expect(setupHold(workspaceId)).toBeNull()
    const releasePreparation = await holdInFlightWorktreeCreate(
      'repo-setup',
      '/tmp/orca-31255-preparing'
    )
    let acquired = false
    const waiting = setupHold(workspaceId)?.then(() => {
      acquired = true
    })
    const releaseSetup = runtime.workspaceSetupAgentStarts.hold(workspaceId)
    releasePreparation()
    await Promise.resolve()
    await Promise.resolve()
    expect(acquired).toBe(false)
    releaseSetup(null)
    await waiting
    expect(acquired).toBe(true)
    expect(setupHold(workspaceId)).toBeNull()
  })

  it('reports every session status change to the mail redrive', async () => {
    const runtime = new OrcaRuntimeService()
    const redrive = vi
      .spyOn(runtime, 'onStructuredSessionStatusForMail')
      .mockImplementation(() => {})
    await runtime.ensureStructuredAgentSessionHost()
    const summary: AgentSessionStatusSummary = {
      sessionId: 'claude_1234abcd',
      workspaceId: 'workspace-1',
      agent: 'claude',
      status: 'idle',
      latestPrompt: '',
      updatedAt: 0
    }
    try {
      installed.deps?.onSessionStatusChanged?.(summary, { replay: false })
    } catch {
      // The same callback's rename half needs a store this bare runtime does not have.
    }
    expect(redrive).toHaveBeenCalledWith(summary)
  })

  it('logs a redrive the database fails, so the status callback goes on to the workspace rename', () => {
    const runtime = new OrcaRuntimeService()
    const closed = new OrchestrationDb(':memory:')
    closed.close()
    vi.spyOn(runtime, 'getExistingOrchestrationDb').mockReturnValue(closed)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      runtime.onStructuredSessionStatusForMail({
        sessionId: '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37',
        status: 'idle'
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] structured session mail redrive failed',
      expect.objectContaining({ sessionId: '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37' })
    )
  })
})
