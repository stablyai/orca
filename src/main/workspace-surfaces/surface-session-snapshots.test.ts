import { ensureWorkspaceSurfaceTables } from './surface-tables'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../native-chat/agent-session-journal/journal-database'
import type { WorkspaceSurfaceDatabase } from './surface-database'
import { WorkspaceSurfaceRepository } from './surface-repository'
import { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import { createStoreDomains } from '../persistence/loading-store/store-domain-composition'

const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
let directory: string
let journal: WorkspaceSurfaceDatabase & { close: () => void }
let runtime: StoreRuntimeState
let repository: WorkspaceSurfaceRepository

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-surface-snapshot-'))
  const fixture = openJournalDatabase(join(directory, 'surfaces.db'))
  journal = {
    ...fixture,
    close: () => fixture.db.close(),
    transaction: (run) => runJournalTransaction(fixture.db, run)
  }
  ensureWorkspaceSurfaceTables(journal.db)
  runtime = new StoreRuntimeState({ dataFile: join(directory, 'profile.json') })
  runtime.state = getDefaultPersistedState(directory)
  repository = new WorkspaceSurfaceRepository(journal)
  runtime.workspaceSurfaces = repository
})
afterEach(async () => {
  clearTimeout(runtime.writeTimer ?? undefined)
  await Promise.all([runtime.staleGithubCacheTempCleanup, runtime.staleProfileStateTempCleanup])
  await journal.close()
  rmSync(directory, { recursive: true, force: true })
})

it.each<ExecutionHostId>(['local', 'ssh:host'])(
  'keeps %s current membership across ordinary saves, patches and unload snapshots',
  (hostId) => {
    const key = { hostId, workspaceId: 'folder', hostTabId: 'container' }
    repository.initialize(hostId, [
      {
        ...key,
        occurrence: 'first',
        revision: 1,
        createdAt: 1,
        content: {
          kind: 'terminal',
          entityId: 'terminal',
          creation: {},
          root: { type: 'leaf', leafId },
          leaves: {
            [leafId]: {
              occurrence: 'leaf',
              runId: 'run',
              facts: { ptyId: 'current', incarnationId: 'child' }
            }
          }
        }
      }
    ])
    const stale = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        folder: [
          {
            id: 'terminal',
            ptyId: 'stale',
            worktreeId: 'folder',
            title: 'Shell',
            customTitle: 'My shell',
            color: null,
            isPinned: true,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'stale' }
        }
      },
      unifiedTabs: {
        folder: [
          {
            id: 'container',
            entityId: 'terminal',
            contentType: 'terminal' as const,
            executionHostId: hostId,
            worktreeId: 'folder',
            label: 'Shell',
            customLabel: 'My shell',
            color: null,
            isPinned: true,
            groupId: 'group',
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const domains = createStoreDomains(runtime)
    domains.sessionSnapshots.setWorkspaceSession(stale, hostId)
    const saved = domains.sessions.getWorkspaceSession(hostId)
    expect(saved.terminalLayoutsByTabId.terminal?.ptyIdsByLeafId?.[leafId]).toBe('current')
    expect(saved.tabsByWorktree.folder?.[0]).toMatchObject({
      customTitle: 'My shell',
      isPinned: true
    })

    repository.replaceContent({
      ...key,
      callerId: 'main',
      commandId: 'close',
      expiresAt: Date.now() + 1000,
      expected: repository.read(key),
      content: null
    })
    domains.sessionSnapshots.setWorkspaceSession(stale, hostId)
    domains.sessionSnapshots.patchWorkspaceSession(
      {
        unifiedTabs: stale.unifiedTabs,
        terminalLayoutsByTabId: stale.terminalLayoutsByTabId,
        tabsByWorktree: stale.tabsByWorktree
      },
      hostId
    )
    domains.sessionSnapshots.stageWorkspaceSessionBeforeUnload(stale, hostId)
    const closed = domains.sessions.getWorkspaceSession(hostId)
    expect(closed.tabsByWorktree.folder ?? []).toEqual([])
    expect(closed.unifiedTabs?.folder ?? []).toEqual([])
    expect(closed.terminalLayoutsByTabId.terminal).toBeUndefined()
    expect(repository.read(key)?.content).toBeNull()
  }
)
