import { describe, expect, it } from 'vitest'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from './prune-mobile-session-tab-group-layout'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

class TestProjectionRuntime extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  constructor() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal store stub for unit test
    super({ onWorkspaceSessionWritten: () => {} } as never)
  }

  seedPty(record: RuntimePtyWorktreeRecord): void {
    this.ptysById.set(record.ptyId, record)
  }

  resolvePty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimePtyWorktreeRecord | null {
    return this.findPtyForMobileTerminalTab(worktreeId, tab)
  }
}

describe('findPtyForMobileTerminalTab', () => {
  const worktreeId = 'repo::/wt'
  const parentTabId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const leafId = 'pane:1'
  const paneKey = `${parentTabId}:${leafId}`

  it('prefers the connected parentLayout leaf PTY when tab.ptyId still references a disconnected PTY', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty({
      ptyId: 'pty-old',
      worktreeId,
      cwd: '/wt',
      tabId: parentTabId,
      paneKey,
      connected: false,
      lastSeenAt: 100
    })
    runtime.seedPty({
      ptyId: 'pty-new',
      worktreeId,
      cwd: '/wt',
      tabId: parentTabId,
      paneKey,
      connected: true,
      lastSeenAt: 200
    })

    const resolved = runtime.resolvePty(worktreeId, {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      title: 'Bash',
      ptyId: 'pty-old',
      parentLayout: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-new' }
      },
      isActive: true
    })

    expect(resolved?.ptyId).toBe('pty-new')
    expect(resolved?.connected).toBe(true)
  })

  it('falls back to scanning ptysById for a connected paneKey match when candidate PTY ids are stale', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty({
      ptyId: 'pty-recovered',
      worktreeId,
      cwd: '/wt',
      tabId: parentTabId,
      paneKey,
      connected: true,
      lastSeenAt: 300
    })

    const resolved = runtime.resolvePty(worktreeId, {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      title: 'Bash',
      ptyId: 'pty-evicted',
      isActive: true
    })

    expect(resolved?.ptyId).toBe('pty-recovered')
    expect(resolved?.connected).toBe(true)
  })
})
