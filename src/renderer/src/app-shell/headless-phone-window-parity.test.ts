// Desktop startup oracle for headless-mobile-session-absorbed-rows.test.ts.

import { expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  HEADLESS_PHONE_LAYOUT_CASES,
  type PhoneLayoutView
} from '../../../shared/workspace-layout/headless-phone-layout.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import {
  bootWindowFromPartitions,
  projectStartupWindowView
} from './startup-window-view.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

/** Project terminal bindings in pane-tree order, matching projectStartupWindowView. */
function paneTerminals(node: unknown): (string | null)[] {
  if (typeof node !== 'object' || node === null) {
    return []
  }
  if ('pane' in node) {
    return [typeof node.pane === 'string' ? node.pane : null]
  }
  return [
    ...('first' in node ? paneTerminals(node.first) : []),
    ...('second' in node ? paneTerminals(node.second) : [])
  ]
}

function windowView(view: Record<string, unknown>, worktreeIds: string[]): PhoneLayoutView {
  const result: PhoneLayoutView = {}
  for (const worktreeId of worktreeIds) {
    const tabIds = Object.keys(view)
      .filter((key) => key.startsWith(`${worktreeId} group `) && key.endsWith(' tabs'))
      .flatMap((key) => (Array.isArray(view[key]) ? view[key].map(String) : []))
    const panes = tabIds.flatMap((tabId) => {
      const terminal = `${worktreeId} terminal ${tabId}`
      if (!(`${terminal} panes` in view)) {
        return []
      }
      const title = String(view[`${terminal} phone and CLI title`])
      const terminals = paneTerminals(view[`${terminal} panes`])
      return terminals.length === 0
        ? [`${tabId} (no layout yet) ${title}`]
        : terminals.map((ptyId) => `${tabId} ${ptyId ?? '-'} ${title}`)
    })
    const active = view[`${worktreeId} active terminal`]
    const groups = Object.keys(view)
      .filter((key) => key.startsWith(`${worktreeId} group `) && key.endsWith(' tabs'))
      .map((key) => {
        const groupActive = view[key.replace(/ tabs$/, ' active tab')]
        return {
          tabs: Array.isArray(view[key]) ? view[key].map(String) : [],
          active: typeof groupActive === 'string' ? groupActive : null
        }
      })
    result[worktreeId] = { panes, active: typeof active === 'string' ? active : null, groups }
  }
  return result
}

it.each(HEADLESS_PHONE_LAYOUT_CASES)('window at startup: $name', async (scenario) => {
  const state = await bootWindowFromPartitions(createTestStore(), [
    { hostId: LOCAL_EXECUTION_HOST_ID, session: scenario.build() }
  ])
  expect(windowView(projectStartupWindowView(state), Object.keys(scenario.desktop))).toEqual(
    scenario.desktop
  )
})
