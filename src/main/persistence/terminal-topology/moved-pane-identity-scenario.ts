import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentHookServer } from '../../agent-hooks/server'
import type { Store } from '../loading-store/store'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import { readPersistedStateJson } from '../../persistence-test-harness'
import { FROM, openStore, SOURCE, WT } from './terminal-leaf-move-fixture'

/** Shared by the moved-pane wiring regressions; each test file mocks `electron` first. */

/** A working row at the pane's first key, so the move has live authority to carry. */
export function seedStatusAtSourceKey(): void {
  agentHookServer.ingestTerminalStatus({
    paneKey: FROM,
    tabId: SOURCE,
    worktreeId: WT,
    payload: { state: 'working', prompt: 'before the move' }
  })
}

/** The window's source-tab close reaches the hook server through this one call. */
export function closeSourceTab(): void {
  agentHookServer.dropStatusEntriesByTabPrefix(SOURCE)
}

/** The live process keeps posting the key it spawned under. */
export function postStatusFromOldKey(prompt: string) {
  agentHookServer.ingestTerminalStatus({
    paneKey: FROM,
    tabId: SOURCE,
    worktreeId: WT,
    payload: { state: 'working', prompt }
  })
}

export function statusRows(): [string, string][] {
  return agentHookServer.getStatusSnapshot().map((row) => [row.paneKey, row.prompt ?? ''])
}

export function persistedAliases(dataFile: string): LegacyPaneKeyAliasEntry[] {
  return JSON.parse(readPersistedStateJson(dataFile)).legacyPaneKeyAliasEntries ?? []
}

/**
 * A graceful restart: the old process is gone and a new Store loads the file, so the persisted aliases pass
 * through load normalization and `registerPersistedPaneKeyAlias` onto the singleton hook server.
 */
export async function restartThroughStore(oldStore: Store, dataFile: string): Promise<Store> {
  oldStore.flush()
  return crashAndRestartThroughStore(oldStore, dataFile)
}

/** A crash: a debounced save still pending is dropped with the process, never flushed. */
export async function crashAndRestartThroughStore(
  oldStore: Store,
  dataFile: string
): Promise<Store> {
  await oldStore.freezeWritesAsync()
  agentHookServer.stop()
  return openStore(dataFile)
}

/** The status file a crash leaves behind: the pane's row still under the key it spawned with. */
export function writeStatusFileAtSourceKey(dataFile: string, prompt: string): void {
  const dir = join(dirname(dataFile), 'agent-hooks')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(dir, 'last-status.json'),
    JSON.stringify({
      version: 2,
      entries: {
        [FROM]: {
          paneKey: FROM,
          tabId: SOURCE,
          worktreeId: WT,
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 1000,
          payload: { state: 'working', prompt, agentType: 'claude' }
        }
      }
    }),
    'utf-8'
  )
}

/** Startup's last step: the hook server hydrates its saved rows through the aliases the Store registered. */
export async function startHookServerOnProfile(dataFile: string): Promise<void> {
  await agentHookServer.start({ env: 'production', userDataPath: dirname(dataFile) })
}
