import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const store = { getSettings: () => ({}) }
  const runtimeArgs: unknown[][] = []
  return {
    store,
    runtimeArgs,
    state: {
      store,
      stats: {},
      activeOrcaProfile: { profile: { id: 'served-profile' } }
    }
  }
})

vi.mock('../github/workspace-links/github-issue-link-title-wiring', () => ({
  wireGitHubIssueLinkTitleFill: () => () => {}
}))
vi.mock('electron', () => ({ app: { getPath: () => '/user-data', once: vi.fn() } }))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    constructor(...args: unknown[]) {
      fixture.runtimeArgs.push(args)
    }
    attachAgentStatusStore() {}
    rehydrateClientHostedBrowserPages() {}
    recordHookStatusResume() {}
    forgetHookStatusResume() {}
    setRecipeWorkspaceRemoval() {}
    startupWorkerAuthority = { begin() {} }
  }
}))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn(),
  installChildSessionSearchService: () => null
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: vi.fn()
}))
vi.mock('../runtime/agent-session/ownership/agent-session-claim-identity', () => ({
  loadAgentSessionClaimSigner: () => null
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: vi.fn(),
    setCliWriterExecutionMatcher: vi.fn(),
    subscribePaneStatusClear: vi.fn(),
    subscribeStatusDrop: vi.fn(),
    attestCompatibilityAuthority: vi.fn(),
    retirePaneAuthority: vi.fn()
  }
}))
vi.mock('../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { setBrowserGuestStateChangedListener: vi.fn(), setOffscreenTabOpener: vi.fn() }
}))
vi.mock('../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {}
}))

import { initializeMainProcessRuntime } from './runtime-startup/main-process-runtime-service'

describe('desktop runtime construction', () => {
  // Bots record link owners from this profile's account; it must be the one whose store this is.
  it("serves the startup profile's store and names that same profile", () => {
    initializeMainProcessRuntime()

    const [store, , deps] = fixture.runtimeArgs[0] ?? []
    expect(store).toBe(fixture.store)
    expect(deps).toMatchObject({ servedOrcaProfileId: 'served-profile' })
  })
})
