import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { SessionReadTerminalHistoryParams } from '../../../shared/rpc-contract/session-terminal-history-params'
import type { TerminalCheckpointFile } from '../../../main/daemon/protocol/daemon-checkpoint-file'
import { writeTerminalHistoryMeta } from '../../../main/daemon/history/storage/terminal-history-metadata'
import { readPersistedState } from '../../../main/persistence/persistence-test-harness'
import { readHostTerminalHistory } from '../../../main/runtime/terminal/output/host-terminal-history-read'
import {
  TEST_LEAF_1,
  TEST_LEAF_2,
  TEST_LEAF_LIVE
} from '../../../main/persistence/persistence-session-fixtures'

export const WORKTREE = 'repo1::/worktree'

export function writeUnseenStartupHistory(historyPath: string, ptyId: string): void {
  const dir = join(historyPath, ptyId)
  mkdirSync(dir, { recursive: true })
  writeTerminalHistoryMeta(dir, {
    cwd: '/worktree',
    cols: 80,
    rows: 24,
    startedAt: '2026-11-10T01:00:00Z',
    endedAt: '2026-11-10T02:00:00Z',
    exitCode: 0
  })
  writeFileSync(
    join(dir, 'checkpoint.json'),
    JSON.stringify({
      snapshotAnsi: `${ptyId} unseen startup output marker\r\n`,
      scrollbackAnsi: '',
      rehydrateSequences: '',
      cwd: '/worktree',
      cols: 80,
      rows: 24,
      scrollbackLines: 0,
      checkpointedAt: '2026-11-10T02:00:00Z',
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: false
      }
    } satisfies TerminalCheckpointFile)
  )
}

export async function expectUnseenDestinations(historyPath: string) {
  const saved = readPersistedState().workspaceSession!
  expect(saved.browserTabsByWorktree?.[WORKTREE]).toEqual([
    expect.objectContaining({ id: 'browser-tab', url: 'https://example.test/research' })
  ])
  expect(saved.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([
    'renderer-tab',
    'later-tab',
    'host-tab'
  ])
  expect(saved.terminalLayoutsByTabId['renderer-tab']).toMatchObject({
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.65,
      first: { type: 'leaf', leafId: TEST_LEAF_1 },
      second: { type: 'leaf', leafId: TEST_LEAF_LIVE }
    },
    ptyIdsByLeafId: { [TEST_LEAF_LIVE]: 'split-pty' }
  })
  expect(saved.terminalLayoutsByTabId['host-tab']).toMatchObject({
    root: { type: 'leaf', leafId: TEST_LEAF_2 },
    ptyIdsByLeafId: { [TEST_LEAF_2]: 'host-pty' }
  })
  expect(saved.terminalPtyIncarnationsByPaneKey).toMatchObject({
    [`host-tab:${TEST_LEAF_2}`]: 'host-incarnation',
    [`renderer-tab:${TEST_LEAF_LIVE}`]: 'split-incarnation'
  })
  expect(saved.tabGroups?.[WORKTREE]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'A', tabOrder: ['renderer-tab', 'browser-tab', 'later-tab'] }),
      expect.objectContaining({ id: 'B', tabOrder: ['host-tab'] })
    ])
  )
  expect(saved.unifiedTabs?.[WORKTREE]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'host-tab',
        groupId: 'B',
        entityId: 'host-tab',
        contentType: 'terminal'
      })
    ])
  )
  expect(saved.tabGroupLayouts?.[WORKTREE]).toEqual({
    type: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    first: { type: 'leaf', groupId: 'A' },
    second: { type: 'leaf', groupId: 'B' }
  })
  for (const [tabId, leafId, expectedSessionId, marker] of [
    ['host-tab', TEST_LEAF_2, 'host-pty', 'host-pty unseen startup output marker'],
    ['renderer-tab', TEST_LEAF_LIVE, 'split-pty', 'split-pty unseen startup output marker']
  ]) {
    const history = await readHostTerminalHistory(
      { getWorkspaceSessionHostIds: () => ['local'], getWorkspaceSession: () => saved },
      historyPath,
      SessionReadTerminalHistoryParams.parse({
        worktreeId: WORKTREE,
        tabId,
        leafId,
        executionHostId: 'local',
        expectedSessionId
      })
    )
    expect(history).toMatchObject({ status: 'restored', cols: 80, rows: 24 })
    if (history.status !== 'restored') {
      throw new Error('saved destination lost its readable history')
    }
    expect(history.scrollback).toContain(marker)
  }
}
