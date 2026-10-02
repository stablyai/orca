import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { applyRuntimeWorktreePsTerminalActivity } from './runtime-worktree-ps-activity'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

const WORKTREE_ID = 'repo::/worktree'
const PTY_ID = `${WORKTREE_ID}@@adopted`

describe('worktree ps restored permission titles', () => {
  it('does not report a historical permission title as a live blocked status', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection touches only the initialized summary fields in this terminal-only test.
    const summary = {
      worktreeId: WORKTREE_ID,
      status: 'inactive',
      hasHostSidebarActivity: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: null,
      preview: ''
    } as unknown as RuntimeWorktreePsSummary
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection and restored-title predicate touch only these initialized PTY fields.
    const pty = {
      ptyId: PTY_ID,
      worktreeId: WORKTREE_ID,
      connected: true,
      tabId: null,
      paneKey: null,
      title: null,
      titleUpdatedAt: null,
      lastOscTitle: '✋ Gemini CLI',
      lastOscTitleAt: 1,
      lastOscTitleEpochMs: null,
      replacedRestoredTitles: [],
      lastOutputAt: null,
      preview: ''
    } as unknown as RuntimePtyWorktreeRecord

    applyRuntimeWorktreePsTerminalActivity({
      summaries: new Map([[WORKTREE_ID, summary]]),
      pathIndex: {
        platformByRepoId: new Map(),
        posixAbsolute: new Map(),
        posixRelative: new Map(),
        windows: new Map(),
        windowsAbsolute: new Map()
      },
      missingIds: new Set(),
      freshPtyLiveness: new Set([PTY_ID]),
      leaves: [],
      ptysById: new Map([[PTY_ID, pty]]),
      tabs: new Map(),
      session: null,
      getPaneKey: () => '',
      getSummary: () => summary
    })

    expect(summary.status).toBe('active')
  })

  it('does not trust a leaf echo of a restored permission title', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection touches only the initialized summary fields in this terminal-only test.
    const summary = {
      worktreeId: WORKTREE_ID,
      status: 'inactive',
      hasHostSidebarActivity: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: null,
      preview: ''
    } as unknown as RuntimeWorktreePsSummary
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection and restored-title predicate touch only these initialized PTY fields.
    const pty = {
      ptyId: PTY_ID,
      worktreeId: WORKTREE_ID,
      connected: true,
      lastOscTitle: '✋ Gemini CLI',
      lastOscTitleEpochMs: null,
      replacedRestoredTitles: []
    } as unknown as RuntimePtyWorktreeRecord
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the leaf projection touches only these initialized fields.
    const leaf = {
      ptyId: PTY_ID,
      worktreeId: WORKTREE_ID,
      connected: true,
      tabId: 'tab-1',
      paneTitle: '✋ Gemini CLI',
      paneTitleUpdatedAt: 1,
      lastOscTitle: '✋ Gemini CLI',
      lastOscTitleAt: 1,
      lastAgentStatus: null,
      lastOutputAt: null,
      preview: ''
    } as unknown as RuntimeLeafRecord

    applyRuntimeWorktreePsTerminalActivity({
      summaries: new Map([[WORKTREE_ID, summary]]),
      pathIndex: {
        platformByRepoId: new Map(),
        posixAbsolute: new Map(),
        posixRelative: new Map(),
        windows: new Map(),
        windowsAbsolute: new Map()
      },
      missingIds: new Set(),
      freshPtyLiveness: new Set([PTY_ID]),
      leaves: [leaf],
      ptysById: new Map([[PTY_ID, pty]]),
      tabs: new Map(),
      session: null,
      getPaneKey: () => 'tab-1:leaf-1',
      getSummary: () => summary
    })

    expect(summary.status).toBe('active')
  })
})
