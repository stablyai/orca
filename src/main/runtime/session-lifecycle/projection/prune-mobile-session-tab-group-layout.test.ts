import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

function createPtyRecord(
  overrides: Partial<RuntimePtyWorktreeRecord> &
    Pick<RuntimePtyWorktreeRecord, 'ptyId' | 'worktreeId'>
): RuntimePtyWorktreeRecord {
  const connected = overrides.connected ?? true
  return {
    incarnationId: null,
    connectionId: null,
    runtimeSessionOwned: false,
    isWsl: null,
    wslDistro: null,
    tabId: null,
    paneKey: null,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: null,
    agentSessionOwners: [],
    foregroundAgent: null,
    connected,
    disconnectedAt: connected ? null : 100,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastAgentStatusStartedAtEpochMs: null,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: null,
    lastOscTitleAt: null,
    lastOscTitleEpochMs: null,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: null,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null,
    ...overrides
  }
}

class TestProjectionRuntime extends OrcaRuntimeService {
  constructor() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal store stub for unit test
    super({ onWorkspaceSessionWritten: () => {} } as never)
  }

  seedPty(record: RuntimePtyWorktreeRecord): void {
    this.ptysById.set(record.ptyId, record)
  }

  resolvePty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options?: { allowWorktreeOnlyMatch?: boolean }
  ): RuntimePtyWorktreeRecord | null {
    return this.findPtyForMobileTerminalTab(worktreeId, tab, options)
  }
}

describe('findPtyForMobileTerminalTab', () => {
  const worktreeId = 'repo::/wt'
  const parentTabId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const leafId = 'pane:1'
  const paneKey = `${parentTabId}:${leafId}`

  it('prefers the connected parentLayout leaf PTY when tab.ptyId still references a disconnected PTY', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-old',
        worktreeId,
        tabId: parentTabId,
        paneKey,
        connected: false,
        lastOutputAt: 100
      })
    )
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-new',
        worktreeId,
        tabId: parentTabId,
        paneKey,
        connected: true,
        lastOutputAt: 200
      })
    )

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

  it('prefers an exact pane match on parentLayout over a worktree-only match on a stale tab.ptyId', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-worktree-only',
        worktreeId,
        tabId: null,
        paneKey: null,
        connected: true,
        lastOutputAt: 100
      })
    )
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-pane-exact',
        worktreeId,
        tabId: parentTabId,
        paneKey,
        connected: true,
        lastOutputAt: 200
      })
    )

    const resolved = runtime.resolvePty(
      worktreeId,
      {
        type: 'terminal',
        id: `${parentTabId}::${leafId}`,
        parentTabId,
        leafId,
        title: 'Bash',
        ptyId: 'pty-worktree-only',
        parentLayout: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-pane-exact' }
        },
        isActive: true
      },
      { allowWorktreeOnlyMatch: true }
    )

    expect(resolved?.ptyId).toBe('pty-pane-exact')
    expect(resolved?.connected).toBe(true)
  })

  it('falls back to scanning ptysById for a connected paneKey match when candidate PTY ids are stale', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-recovered',
        worktreeId,
        tabId: parentTabId,
        paneKey,
        connected: true,
        lastOutputAt: 300
      })
    )

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

  it('restricts disconnected paneKey fallback to the requested worktree when no candidate PTY ids are present', () => {
    const runtime = new TestProjectionRuntime()
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-other-worktree',
        worktreeId: 'repo::/other-wt',
        tabId: parentTabId,
        paneKey,
        connected: false,
        lastOutputAt: 100
      })
    )
    runtime.seedPty(
      createPtyRecord({
        ptyId: 'pty-same-worktree',
        worktreeId,
        tabId: parentTabId,
        paneKey,
        connected: false,
        lastOutputAt: 200
      })
    )

    const resolved = runtime.resolvePty(worktreeId, {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      title: 'Bash',
      isActive: true
    })

    expect(resolved?.ptyId).toBe('pty-same-worktree')
    expect(resolved?.worktreeId).toBe(worktreeId)
  })
})
