import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { PersistedState } from '../shared/persisted-state-types'
import { makePaneKey } from '../shared/stable-pane-id'
import { agentHookServer } from './agent-hooks/server'
import { makeBalancedLegacyPaneLayout } from './persistence-session-fixtures'
import { Store } from './persistence/loading-store/store'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeProfile(dir: string, state: Record<string, unknown>): string {
  const dataFile = join(dir, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
  return dataFile
}

function legacySplitLayoutProfile(tabId: string, ptyId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceSession: {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: tabId,
      tabsByWorktree: {
        wt1: [
          {
            id: tabId,
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: makeBalancedLegacyPaneLayout(0, 2),
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      }
    }
  }
}

function readProfile(dataFile: string): PersistedState {
  return JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
}

const RUNTIME_PANE_KEY = makePaneKey('tab-own', '9f0e1d2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f')
const RUNTIME_UPDATED_AT = 1_700_000_000_000

describe('Store hook-server listener ownership', () => {
  let dirs: string[] = []

  beforeEach(() => {
    dirs = []
    installFakeAppEnvironment({ getPath: () => tmpdir() })
  })

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-listener-ownership-'))
    dirs.push(dir)
    return dir
  }

  it('does not write a later store’s hydrated aliases into an earlier store’s profile', () => {
    const earlierFile = writeProfile(makeDir(), { schemaVersion: 1 })
    const earlier = new Store({ dataFile: earlierFile })

    // Why: the later store replays its own legacy layout; the earlier store must not observe it.
    const laterFile = writeProfile(makeDir(), legacySplitLayoutProfile('tab-later', 'pty-later'))
    new Store({ dataFile: laterFile })

    earlier.flush()
    const earlierAliases = readProfile(earlierFile).legacyPaneKeyAliasEntries ?? []
    expect(earlierAliases).toEqual([])
  })

  it('persists an alias the hook server registers after the store takes ownership', () => {
    const dataFile = writeProfile(makeDir(), legacySplitLayoutProfile('tab-own', 'pty-own'))
    const store = new Store({ dataFile })

    // Why: hydrated rows reach `state` through normalization alone, so asserting on those watches
    // nothing. Only the listener the constructor re-installs can carry a post-construction alias to
    // disk — that is what the detach above must hand over rather than destroy.
    agentHookServer.registerPaneKeyAlias(
      'tab-own:7',
      RUNTIME_PANE_KEY,
      'pty-runtime',
      RUNTIME_UPDATED_AT
    )

    store.flush()
    const aliases = readProfile(dataFile).legacyPaneKeyAliasEntries ?? []
    expect(aliases).toContainEqual({
      legacyPaneKey: 'tab-own:7',
      stablePaneKey: RUNTIME_PANE_KEY,
      ptyId: 'pty-runtime',
      updatedAt: RUNTIME_UPDATED_AT
    })
    // The listener replaces the whole persisted list, so the hydrated rows must survive the replace.
    expect(aliases.some((entry) => entry.legacyPaneKey === 'tab-own:1')).toBe(true)
  })
})
