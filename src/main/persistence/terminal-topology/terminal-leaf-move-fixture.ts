import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { Store } from '../loading-store/store'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

/** Shared by the move tests; each test file mocks `electron` before importing this. */

export const WT = 'repo-1::/tmp/move-worktree'
export const SOURCE = 'tab-source'
export const TARGET = 'tab-target'
export const LEFT = '11111111-1111-4111-8111-111111111111'
export const MOVED = '22222222-2222-4222-8222-222222222222'
export const FROM = `${SOURCE}:${MOVED}`
export const TO = `${TARGET}:${MOVED}`

const stores: Store[] = []

export async function closeMoveTestStores(): Promise<void> {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
}

export function newDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-leaf-move-'))), 'state.json')
}

export function openStore(dataFile: string): Store {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

export function sleeping(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: WT,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-1' },
    prompt: 'go',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

/** A split source tab whose second leaf runs the agent that gets moved. */
export async function seedSplitSource(store: Store, hostId?: string): Promise<void> {
  await store.persistPtyBinding(
    { worktreeId: WT, tabId: SOURCE, leafId: LEFT, ptyId: 'pty-left', incarnationId: 'inc-left' },
    hostId
  )
  await store.persistPtyBinding(
    { worktreeId: WT, tabId: SOURCE, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' },
    hostId
  )
}

export function ownersOf(session: WorkspaceSessionState, ptyId: string): string[] {
  return Object.entries(session.terminalLayoutsByTabId).flatMap(([tabId, layout]) =>
    collectLayoutLeafIdsInOrder(layout.root)
      .filter((leafId) => layout.ptyIdsByLeafId?.[leafId] === ptyId)
      .map((leafId) => `${tabId}:${leafId}`)
  )
}

export function tabsHoldingLeaf(session: WorkspaceSessionState, leafId: string): string[] {
  return Object.entries(session.terminalLayoutsByTabId)
    .filter(([, layout]) => collectLayoutLeafIdsInOrder(layout.root).includes(leafId))
    .map(([tabId]) => tabId)
}

export const moveRequest = {
  worktreeId: WT,
  sourceTabId: SOURCE,
  targetTabId: TARGET,
  leafId: MOVED
}
