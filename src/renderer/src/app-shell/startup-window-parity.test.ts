// Compare window startup from disk with the Loader round trip. Enumerate each divergence as a known defect or accepted difference with its reason.

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import {
  ACCEPTED_DIFFERENCES,
  GIT,
  KNOWN_DIFFERENCES,
  sweptAtStartup
} from './startup-window-parity-differences.test-fixture'
import {
  bootWindowFromPartitions,
  diffStartupWindowViews,
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
vi.mock('@/lib/agent-status', async (importOriginal) => {
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
  it.each(PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s',
    async (name, { hostId, build }) => {
      const stored = build()
      const storedView = projectStartupWindowView(
        await bootWindowFromPartitions(createTestStore(), [{ hostId, session: stored }])
      )
      const normalizedView = projectStartupWindowView(
        await bootWindowFromPartitions(createTestStore(), [
          { hostId, session: normalize(hostId, stored) }
        ])
      )
      // The window must show the stored workspaces at all, or an empty view hides differences.
      for (const [key, rows] of Object.entries(stored.tabsByWorktree)) {
        if (rows.length > 0) {
          expect(storedView, key).toHaveProperty([`${key} group 0 tabs`])
        }
      }
      const differences = diffStartupWindowViews(storedView, normalizedView)
      const known = KNOWN_DIFFERENCES.filter((entry) => entry.fixture === name)
      const accepted = ACCEPTED_DIFFERENCES.filter((entry) => entry.fixture === name)
      expect(
        differences.map((difference) => difference.path).sort(),
        `window differences (stored vs normalized):\n${JSON.stringify(differences, null, 2)}`
      ).toEqual(
        [
          ...known.flatMap((entry) => entry.paths),
          ...accepted.flatMap((entry) => Object.keys(entry.values))
        ].sort()
      )
      // An accepted difference stays accepted only while it shows exactly the recorded values.
      const acceptedValues = Object.assign({}, ...accepted.map((entry) => entry.values))
      expect(
        Object.fromEntries(
          differences
            .filter((difference) => difference.path in acceptedValues)
            .map(({ path, stored, normalized }) => [path, { stored, normalized }])
        )
      ).toEqual(acceptedValues)
    }
  )

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

  it('restores the terminals of a session from before the tab bar, dropping its file tabs', async () => {
    const profile = PROFILES.find(
      (entry) => entry.name === 'session from before the tab bar, with an open file'
    )!
    const view = projectStartupWindowView(
      await bootWindowFromPartitions(createTestStore(), [
        { hostId: profile.hostId, session: profile.build() }
      ])
    )
    expect(view[`${GIT} group 0 tabs`]).toEqual(['tab-a', 'tab-b'])
    expect(view).not.toHaveProperty([`${GIT} tab /Users/dev/orca/src/app.ts`])
  })

  it('lists differences only for fixtures that exist', () => {
    const names = new Set(PROFILES.map((profile) => profile.name))
    expect(
      [...KNOWN_DIFFERENCES, ...ACCEPTED_DIFFERENCES].filter((entry) => !names.has(entry.fixture))
    ).toEqual([])
  })
})
