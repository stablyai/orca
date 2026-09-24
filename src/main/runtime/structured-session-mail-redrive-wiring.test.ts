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

describe("the runtime's own structured host install", () => {
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

    // A committed `/clear` is the replacement's adoption edge: its own first status edge came first.
    installed.deps?.onConversationReplaced?.({
      sessionId: 'claude_1234abcd',
      replacementSessionId: 'clear-1234abcd'
    })
    expect(redrive).toHaveBeenCalledWith({ sessionId: 'clear-1234abcd', status: null })
  })
})
