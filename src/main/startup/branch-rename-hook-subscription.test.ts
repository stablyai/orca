import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'

const hooks = vi.hoisted(() => {
  const listeners: ((event: EnrichedAgentHookEventPayload) => void)[] = []
  return { listeners, rename: vi.fn(() => Promise.resolve()) }
})

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: EnrichedAgentHookEventPayload) => void) => {
      hooks.listeners.push(listener)
      return () => {}
    }
  }
}))
vi.mock('../agent-hooks/first-work-branch-rename', () => ({
  maybeAutoRenameBranchOnFirstWork: hooks.rename
}))
vi.mock('../agent-hooks/first-work-rename-runtime', () => ({ firstWorkRenameDeps: () => ({}) }))

import { installFirstWorkRenameHookSubscription } from './branch-rename-hook'
import { mainProcessState } from './main-process-state'

function working(over: Partial<EnrichedAgentHookEventPayload> = {}): EnrichedAgentHookEventPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription reads only the routing, payload and gate fields set here.
  return {
    paneKey: 'pane-1',
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'working', prompt: 'Fix the auth bug', agentType: 'claude' },
    ...over
  } as EnrichedAgentHookEventPayload
}

beforeEach(() => {
  hooks.listeners.length = 0
  hooks.rename.mockClear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename entry only checks these singletons exist before handing them to the mocked deps.
  mainProcessState.store = {} as typeof mainProcessState.store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  mainProcessState.runtime = {} as typeof mainProcessState.runtime
})

// Why: the rename used to hang off the window's hook listener, which headless serve never installs.
describe('first-work rename hook subscription', () => {
  it('arms rename from the hook store with no window', () => {
    installFirstWorkRenameHookSubscription()
    hooks.listeners[0](working())

    expect(hooks.rename).toHaveBeenCalledTimes(1)
    expect(hooks.rename.mock.calls[0]).toEqual([
      expect.objectContaining({ paneKey: 'pane-1', state: 'working', prompt: 'Fix the auth bug' }),
      {}
    ])
  })

  it('keeps the window path gates: identity refreshes, restored rows and structured rows', () => {
    installFirstWorkRenameHookSubscription()
    hooks.listeners[0](working({ providerSessionOnly: true }))
    hooks.listeners[0](working({ restoredUnconfirmed: true }))
    hooks.listeners[0](working({ structuredHost: 'owned' }))

    expect(hooks.rename).not.toHaveBeenCalled()
  })
})
