// Compare window startup from disk with the Loader round trip. Enumerate each divergence as a known defect or accepted difference with its reason.

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { createStoreSessionMockApi } from '../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { GIT, sweptAtStartup } from './startup-window-parity-differences.test-fixture'
import {
  bootWindowFromPartitions,
  projectStartupWindowView
} from './startup-window-view.test-fixture'

// Use legacy window boot as the oracle for main-owned layout loading.
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

/** Main's startup sweep, then the shared Loader's round trip, as main would persist it. */
function normalize(hostId: ExecutionHostId, session: WorkspaceSessionState): WorkspaceSessionState {
  let next = 0
  layoutOwner.isMain = true
  try {
    const loaded = loadWorkspaceLayout(hostId, sweptAtStartup(hostId, structuredClone(session)), {
      mintId: () => `minted-${++next}`,
      mintLeafId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, '0')}`
    })
    return saveWorkspaceLayout(loaded)
  } finally {
    layoutOwner.isMain = false
  }
}

const PROFILES = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

describe('the window shows the same session before and after the shared Loader rewrites it', () => {
  it('keeps the tab-bar twin selected when a selected legacy copy is dropped', async () => {
    const profile = PROFILES.find(
      (entry) => entry.name === 'legacy row repeating a tab-bar tab’s terminal, selected'
    )!
    const view = projectStartupWindowView(
      await bootWindowFromPartitions(createTestStore(), [
        { hostId: profile.hostId, session: normalize(profile.hostId, profile.build()) }
      ])
    )
    expect(view['active.terminal']).toBe('tab-a')
    expect(view[`${GIT} active terminal`]).toBe('tab-a')
  })

  it('restores terminals and saved edit tabs from a session before the tab bar', async () => {
    const profile = PROFILES.find(
      (entry) => entry.name === 'session from before the tab bar, with an open file'
    )!
    const view = projectStartupWindowView(
      await bootWindowFromPartitions(createTestStore(), [
        { hostId: profile.hostId, session: profile.build() }
      ])
    )
    expect(view[`${GIT} group 0 tabs`]).toEqual(['/Users/dev/orca/src/app.ts', 'tab-a', 'tab-b'])
    expect(view).toHaveProperty([`${GIT} tab /Users/dev/orca/src/app.ts`])
  })
})
