import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import {
  makeTerminalScrollbackSnapshotRef,
  migrateWorkspaceSessionTerminalScrollbackSnapshots
} from './terminal-scrollback-snapshots'

function tab(id: string, incognito?: boolean): TerminalTab {
  return {
    id,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ptyId: `${id}-pty`,
    worktreeId: 'repo::/wt',
    ...(incognito ? { incognito: true } : {})
  }
}

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: { 'repo::/wt': [tab('normal-tab'), tab('incognito-tab', true)] },
    terminalLayoutsByTabId: {
      'normal-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'normal-scrollback-content' }
      },
      'incognito-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'SECRET-incognito-scrollback' }
      }
    }
  } as WorkspaceSessionState
}

describe('migrateWorkspaceSessionTerminalScrollbackSnapshots incognito guard', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-scrollback-incognito-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('never writes a snapshot file or ref for an incognito tab, but does for a normal tab', () => {
    const { session, changed } = migrateWorkspaceSessionTerminalScrollbackSnapshots(makeSession(), {
      snapshotRoot: root
    })

    expect(changed).toBe(true)

    // Normal tab: externalized to a ref + on-disk file, buffer removed.
    const normalLayout = session.terminalLayoutsByTabId!['normal-tab']
    const normalRef = normalLayout.scrollbackRefsByLeafId?.['pane:1']
    expect(normalRef).toBe(makeTerminalScrollbackSnapshotRef('normal-tab', 'pane:1'))
    expect(existsSync(join(root, `${normalRef}.bin`))).toBe(true)
    expect(normalLayout.buffersByLeafId).toBeUndefined()

    // Incognito tab: skipped entirely — no ref, and NO file on disk. The inline buffer is left for
    // the prune to strip (the prune runs before this in the real save path).
    const incognitoLayout = session.terminalLayoutsByTabId!['incognito-tab']
    expect(incognitoLayout.scrollbackRefsByLeafId).toBeUndefined()
    const incognitoRef = makeTerminalScrollbackSnapshotRef('incognito-tab', 'pane:1')
    expect(existsSync(join(root, `${incognitoRef}.bin`))).toBe(false)
  })
})
