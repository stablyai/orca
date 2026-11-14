import { expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerSessionHandlers } from './session'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requireSwitchedOn } from '../runtime/construction/require-sidebar-inputs-enabled'
import { readRuntimeDesktopSidebarFacts } from '../runtime/sidebar-inputs/sidebar-inputs-feed-domains'
import { TERMINAL_QUERY_METHODS } from '../runtime/rpc/methods/terminal/terminal-query-methods'
import { createWorkerMaintenanceFixture } from '../persistence/loading-store/profile-writing/profile-state-maintenance-fixture'

vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it('keeps renderer field saves after runtime startup, sidebar, crew and agent identity reads', async () => {
  const { store, authority, readState } = await createWorkerMaintenanceFixture()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler)
  })
  const runtime = new OrcaRuntimeService(store)
  const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
  feed.acquire('field-save-test')
  const unwatch = runtime.watchOrchestrationCrew(() => {})
  try {
    registerSessionHandlers(store, runtime)
    const get = handlers.get('session:get')!
    const patch = handlers.get('session:patch')!
    const first = structuredClone(get({}))
    expect(first).toHaveProperty('tabsByWorktree')
    patch({}, structuredClone({ activeTabId: 'first' }))
    await store.flushPendingOrThrowAsync()
    readRuntimeDesktopSidebarFacts(store, undefined)
    for (const method of TERMINAL_QUERY_METHODS) {
      if (method.name === 'terminal.agentId') {
        await method.handler(
          { paneKey: 'field-tab:field-leaf', worktreeId: 'field-repo::/synthetic' },
          { runtime }
        )
      }
    }
    await runtime.listTerminals()
    const writes = vi.spyOn(authority, 'writePreparedState')
    structuredClone(get({}))
    patch({}, structuredClone({ activeTabId: 'second' }))
    await store.flushPendingOrThrowAsync()
    expect(writes.mock.calls[0]?.[0]).toMatchObject({
      replacements: [],
      patches: [
        {
          domain: 'workspaceSession',
          operations: [{ kind: 'set', path: ['activeTabId'], payload: '"second"' }]
        }
      ]
    })
    expect(readState().workspaceSession.activeTabId).toBe('second')
  } finally {
    unwatch()
    feed.release('field-save-test')
  }
})
