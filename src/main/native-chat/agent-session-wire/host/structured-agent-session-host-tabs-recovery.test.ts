import { describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionTabVisibility } from './structured-agent-session-host-tabs'

function visibilityHost() {
  return {
    deps: {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      store: { setSessionTabVisibility: vi.fn(async () => {}) }
    },
    restartResume: { dismiss: vi.fn(async () => 0) }
  }
}

describe('setStructuredAgentSessionTabVisibility', () => {
  it("forgets restart recovery when a person's close hides a chat", async () => {
    const host = visibilityHost()
    await setStructuredAgentSessionTabVisibility(host, 's1', false)
    expect(host.restartResume.dismiss).toHaveBeenCalledWith(['s1'])
  })

  it("keeps restart recovery when Orca's own hide does", async () => {
    const host = visibilityHost()
    await setStructuredAgentSessionTabVisibility(host, 's1', false, undefined, undefined, true)
    expect(host.deps.store.setSessionTabVisibility).toHaveBeenCalled()
    expect(host.restartResume.dismiss).not.toHaveBeenCalled()
  })
})
