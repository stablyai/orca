import { ensureWorkspaceSurfaceTables } from './surface-tables'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../native-chat/agent-session-journal/journal-database'
import type { WorkspaceSurfaceDatabase } from './surface-database'
import { WorkspaceSurfaceRepository } from './surface-repository'
import type { SurfaceContentReplacement } from '../../shared/workspace-surfaces/surface-command'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import { runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import { nameBasedUuid } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { workspaceSurfaceSchema } from '../../shared/workspace-surfaces/surface-schema'
import { rebuildLegacyChatTabs } from './surface-rows'

let directory: string
let journal: WorkspaceSurfaceDatabase & { close: () => void }
let repository: WorkspaceSurfaceRepository
let sequence = 0
const paneId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
const newPaneId = '8ce90067-aa40-5dcd-b919-f6b91ccc3b52'
const key = { hostId: 'local', workspaceId: 'folder', hostTabId: 'tab' }
const terminal: WorkspaceSurface = {
  ...key,
  occurrence: 'content-1',
  revision: 1,
  createdAt: 1,
  content: {
    kind: 'terminal',
    entityId: 'tab',
    creation: {},
    root: { type: 'leaf', leafId: paneId },
    leaves: {
      [paneId]: {
        occurrence: 'leaf-1',
        runId: 'run-1',
        facts: { ptyId: 'pty-1', incarnationId: 'inc-1' }
      }
    }
  }
}
const model: WorkspaceLayoutModel = {
  hostId: 'local',
  workspaces: {},
  records: {},
  legacy: { terminalRowOwners: {} }
}
const context = {
  mintId: () => `id-${++sequence}`,
  mintLeafId: () => nameBasedUuid(`leaf-${++sequence}`),
  now: () => 100
}

function openFixture(): WorkspaceSurfaceDatabase & { close: () => void } {
  const opened = openJournalDatabase(join(directory, 'repository-fixture.db'))
  return {
    ...opened,
    transaction: (run) => runJournalTransaction(opened.db, run),
    close: () => opened.db.close()
  }
}

function withLegacyProjection(now = context.now): WorkspaceSurfaceRepository {
  return new WorkspaceSurfaceRepository(
    {
      get db() {
        return journal.db
      },
      get readOnly() {
        return journal.readOnly
      },
      transaction: (run) =>
        journal.transaction((db) => {
          const result = run(db)
          rebuildLegacyChatTabs(db, 'main', 'local')
          return result
        })
    },
    context.mintId,
    now
  )
}

function replacement(
  overrides: Partial<SurfaceContentReplacement> = {}
): SurfaceContentReplacement {
  return {
    ...key,
    callerId: 'window',
    commandId: `command-${++sequence}`,
    expiresAt: 1000,
    expected: { occurrence: 'content-1', revision: 1 },
    content: null,
    ...overrides
  }
}

function startPendingPane(): ReturnType<typeof runTargetOf> {
  const current = repository.read(key)!
  const target = runTargetOf(current, paneId)!
  const result = repository.applyLayout(
    {
      hostId: 'local',
      callerId: 'window',
      commandId: `start-${++sequence}`,
      expiresAt: 1000,
      command: { type: 'startPane', workspace: 'folder', paneKey: `tab:${paneId}` },
      targets: [
        {
          hostTabId: 'tab',
          expected: { occurrence: current.occurrence },
          leaf: {
            leafId: paneId,
            occurrence: target.leafOccurrence,
            runId: target.runId
          }
        }
      ]
    },
    { model, context }
  )
  expect(result.status).toBe('accepted')
  return runTargetOf(repository.read(key)!, paneId)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-canonical-surfaces-'))
  sequence = 0
  journal = openFixture()
  ensureWorkspaceSurfaceTables(journal.db)
  repository = withLegacyProjection()
})

afterEach(async () => {
  await journal.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('canonical surface command durability', () => {
  it('persists initialized-empty absence across reopen rather than importing a stale legacy row', async () => {
    repository.initialize('local', [])
    journal.db
      .prepare('INSERT INTO agent_session_tabs(tab_id, session_id, position) VALUES (?, ?, ?)')
      .run('old', 'stale', 0)
    await journal.close()
    journal = openFixture()
    ensureWorkspaceSurfaceTables(journal.db)
    repository = withLegacyProjection()
    repository.initialize('local', [terminal])
    expect(repository.initialized('local')).toBe(true)
    expect(repository.list('local', 'folder')).toEqual([])
  })

  it('replays acceptance after close and reopen, while stale commands cannot mutate the successor', async () => {
    repository.initialize('local', [terminal])
    const close = replacement()
    const accepted = repository.replaceContent(close)
    expect(accepted.status).toBe('accepted')
    const closed = repository.read(key)!
    const reopened = repository.replaceContent(
      replacement({
        expected: { occurrence: closed.occurrence, revision: closed.revision },
        content:
          terminal.content?.kind === 'terminal'
            ? {
                ...terminal.content,
                leaves: { [paneId]: { occurrence: 'new-leaf', runId: 'new-run', facts: {} } }
              }
            : null
      })
    )
    expect(reopened.status).toBe('accepted')
    const successor = repository.read(key)
    await journal.close()
    journal = openFixture()
    ensureWorkspaceSurfaceTables(journal.db)
    repository = withLegacyProjection()
    expect(repository.replaceContent(close)).toEqual(accepted)
    expect(repository.read(key)).toEqual(successor)
    expect(repository.replaceContent(replacement())).toMatchObject({
      status: 'conflict',
      code: 'surface_changed',
      current: successor
    })
  })

  it('co-writes canonical chat membership and its legacy index, including rollback on projection failure', () => {
    repository.initialize('local', [terminal])
    const open = replacement({
      content: { kind: 'agent-session', sessionId: 'chat', agent: 'codex' }
    })
    journal.db.exec(`CREATE TRIGGER reject_chat_projection BEFORE INSERT ON agent_session_tabs
      BEGIN SELECT RAISE(ABORT, 'projection failure'); END`)
    expect(() => repository.replaceContent(open)).toThrow('projection failure')
    expect(repository.read(key)).toEqual(terminal)
    expect(journal.db.prepare('SELECT * FROM workspace_surface_commands').all()).toEqual([])
    journal.db.exec('DROP TRIGGER reject_chat_projection')
    expect(repository.replaceContent(open).status).toBe('accepted')
    expect(journal.db.prepare('SELECT tab_id, session_id FROM agent_session_tabs').all()).toEqual([
      { tab_id: 'tab', session_id: 'chat' }
    ])
    const chat = repository.read(key)!
    repository.replaceContent(replacement({ expected: chat, content: null }))
    expect(journal.db.prepare('SELECT * FROM agent_session_tabs').all()).toEqual([])
  })

  it('applies a split through the existing reducer using canonical membership and exact leaf identity', () => {
    repository.initialize('local', [terminal])
    const split = {
      hostId: 'local',
      callerId: 'window',
      commandId: 'split',
      expiresAt: 1000,
      command: {
        type: 'splitPane' as const,
        workspace: 'folder',
        tabId: 'tab',
        leafId: paneId,
        direction: 'horizontal' as const,
        newLeafId: newPaneId
      },
      targets: [
        {
          hostTabId: 'tab',
          expected: { occurrence: 'content-1' },
          leaf: { leafId: paneId, occurrence: 'leaf-1', runId: 'run-1' }
        }
      ]
    }
    const outcome = repository.applyLayout(split, { model, context })
    expect(outcome.status).toBe('accepted')
    expect(repository.read(key)?.content).toMatchObject({
      kind: 'terminal',
      root: { type: 'split', first: { leafId: paneId }, second: { leafId: newPaneId } },
      leaves: {
        [paneId]:
          terminal.content?.kind === 'terminal' ? terminal.content.leaves[paneId] : undefined
      }
    })
    expect(
      repository.applyLayout(
        {
          ...split,
          commandId: 'stale',
          targets: [
            {
              ...split.targets[0]!,
              leaf: { leafId: paneId, occurrence: 'reopened', runId: 'run-1' }
            }
          ]
        },
        { model, context }
      )
    ).toMatchObject({ status: 'conflict', code: 'pane_changed' })
  })

  it('moves the one open view of a conversation atomically without deleting the conversation', () => {
    const chat: WorkspaceSurface = {
      ...terminal,
      content: { kind: 'agent-session', sessionId: 'chat', agent: 'codex' }
    }
    repository.initialize('local', [chat])
    const moved = repository.replaceContent(
      replacement({
        workspaceId: 'another-folder',
        expected: null,
        content: chat.content
      })
    )
    expect(moved).toMatchObject({
      status: 'accepted',
      surfaces: expect.arrayContaining([
        expect.objectContaining({ ...key, content: null }),
        expect.objectContaining({ ...key, workspaceId: 'another-folder', content: chat.content })
      ])
    })
    expect(repository.read({ ...key, workspaceId: 'another-folder' })?.content).toEqual(
      chat.content
    )
    expect(repository.list('local', 'folder')[0]?.content).toBeNull()
    expect(journal.db.prepare('SELECT tab_id, session_id FROM agent_session_tabs').all()).toEqual([
      { tab_id: 'tab', session_id: 'chat' }
    ])
  })

  it('keeps a host tab identity owned across workspaces and content kinds', () => {
    repository.initialize('local', [terminal])
    expect(
      repository.replaceContent(
        replacement({
          workspaceId: 'other',
          expected: null,
          content: { kind: 'agent-session', sessionId: 'chat', agent: 'codex' }
        })
      )
    ).toMatchObject({ status: 'conflict', code: 'tab_exists' })
    expect(repository.read(key)).toEqual(terminal)
    expect(repository.read({ ...key, workspaceId: 'other' })).toBeNull()
  })

  it('rejects inconsistent membership before seeding any authority', () => {
    expect(() =>
      repository.initialize('local', [
        {
          ...terminal,
          content:
            terminal.content?.kind === 'terminal'
              ? { ...terminal.content, chatLeafId: 'missing' }
              : null
        }
      ])
    ).toThrow('terminal membership is inconsistent')
    expect(repository.initialized('local')).toBe(false)
    expect(repository.list('local', 'folder')).toEqual([])
    expect(
      workspaceSurfaceSchema.safeParse({
        ...terminal,
        content:
          terminal.content?.kind === 'terminal'
            ? {
                ...terminal.content,
                root: {
                  type: 'split',
                  direction: 'horizontal',
                  first: { type: 'leaf', leafId: paneId },
                  second: { type: 'leaf', leafId: paneId }
                }
              }
            : null
      }).success
    ).toBe(false)
  })

  it('admits from canonical identities, ignoring stale unrelated window contents', () => {
    repository.initialize('local', [])
    const create = {
      hostId: 'local',
      callerId: 'window',
      commandId: 'create',
      expiresAt: 1000,
      command: {
        type: 'createTerminalTab' as const,
        workspace: 'folder',
        tabId: 'tab',
        leafId: paneId
      },
      targets: [{ hostTabId: 'tab', expected: null }]
    }
    const stale = {
      ...model,
      workspaces: {
        unrelated: {
          worktreeId: 'unrelated',
          tabs: [
            {
              id: 'tab',
              entityId: 'tab',
              kind: 'terminal' as const,
              createdAt: 1,
              customTitle: null,
              color: null,
              terminal: {},
              panes: { root: { type: 'leaf' as const, leafId: paneId } }
            }
          ],
          groups: [],
          leaves: {}
        }
      }
    }
    expect(repository.applyLayout(create, { model: stale, context }).status).toBe('accepted')
    const current = repository.read(key)!
    // A different workspace cannot acquire the same actual host entity or leaf.
    expect(
      repository.replaceContent(
        replacement({
          workspaceId: 'other',
          hostTabId: 'other',
          expected: null,
          content: current.content
        })
      )
    ).toMatchObject({ status: 'conflict', code: 'tab_exists' })
    if (current.content?.kind !== 'terminal') {
      throw new Error('expected terminal')
    }
    expect(
      repository.replaceContent(
        replacement({
          workspaceId: 'other',
          hostTabId: 'other',
          expected: null,
          content: { ...current.content, entityId: 'other' }
        })
      )
    ).toMatchObject({ status: 'conflict', code: 'pane_in_other_tab' })
    expect(repository.list('local', 'other')).toEqual([])
    expect(repository.read(key)).toEqual(current)
  })

  it('keeps exact cancellation across close, late bind and database restart until executor acknowledgment', async () => {
    const pending = structuredClone(terminal)
    if (pending.content?.kind !== 'terminal') {
      throw new Error('expected terminal')
    }
    pending.content.leaves[paneId]!.facts = {}
    repository.initialize('local', [pending])
    const target = startPendingPane()!
    expect(repository.runs.beginRun(target, 'candidate')).toMatchObject({
      status: 'accepted',
      allocation: {
        allocationId: target.runId,
        decision: 'pending',
        resourceId: 'candidate'
      }
    })
    repository.replaceContent(replacement({ expected: repository.read(key)! }))
    const closed = repository.read(key)!
    repository.replaceContent(
      replacement({
        expected: closed,
        content: {
          ...pending.content,
          leaves: { [paneId]: { occurrence: 'next-leaf', runId: 'next-run', facts: {} } }
        }
      })
    )
    const successor = repository.read(key)
    expect(
      repository.runs.bindRun('local', target.runId, {
        ptyId: 'candidate',
        incarnationId: 'old-child'
      })
    ).toMatchObject({ status: 'accepted', allocation: { decision: 'aborting' } })
    expect(repository.read(key)).toEqual(successor)
    expect(
      repository.runs.acknowledgeRun({
        hostId: 'local',
        allocationId: target.runId,
        decision: 'committed',
        resource: { ptyId: 'candidate', incarnationId: 'old-child' }
      })
    ).toBe(false)
    await journal.close()
    journal = openFixture()
    ensureWorkspaceSurfaceTables(journal.db)
    repository = withLegacyProjection(() => 1_000_000)
    expect(repository.runs.allocations('local')).toMatchObject([
      {
        decision: 'aborting',
        resource: {
          ptyId: 'candidate',
          incarnationId: 'old-child'
        }
      }
    ])
    expect(
      repository.runs.acknowledgeRun({
        hostId: 'local',
        allocationId: target.runId,
        decision: 'aborting',
        proof: 'stopped_and_fenced'
      })
    ).toBe(true)
    expect(repository.runs.allocations('local')).toEqual([])
    expect(repository.read(key)).toEqual(successor)
  })

  it('commits binding and adoption decision together, and closing supersedes a late adoption acknowledgment', () => {
    const pending = structuredClone(terminal)
    if (pending.content?.kind !== 'terminal') {
      throw new Error('expected terminal')
    }
    pending.content.leaves[paneId]!.facts = {}
    repository.initialize('local', [pending])
    const target = startPendingPane()!
    expect(repository.runs.bindRun('local', target.runId, { ptyId: 'unclaimed' })).toEqual({
      status: 'conflict',
      code: 'allocation_changed'
    })
    repository.runs.beginRun(target, 'candidate')
    // Retrying enrollment cannot mint a second executor identity.
    expect(repository.runs.beginRun(target, 'second-candidate')).toMatchObject({
      status: 'accepted',
      allocation: { resourceId: 'candidate' }
    })
    const resource = { ptyId: 'candidate', incarnationId: 'child' }
    expect(repository.runs.bindRun('local', target.runId, { ptyId: 'other-child' })).toEqual({
      status: 'conflict',
      code: 'allocation_changed'
    })
    expect(repository.runs.bindRun('local', target.runId, resource)).toMatchObject({
      status: 'accepted',
      allocation: { decision: 'committed', resource }
    })
    expect(repository.read(key)?.content).toMatchObject({
      leaves: { [paneId]: { facts: resource } }
    })
    repository.replaceContent(replacement({ expected: repository.read(key)! }))
    expect(
      repository.runs.acknowledgeRun({
        hostId: 'local',
        allocationId: target.runId,
        decision: 'committed',
        resource
      })
    ).toBe(false)
    expect(repository.runs.allocations('local')).toMatchObject([{ decision: 'aborting', resource }])
  })

  it('transfers a pending run with its pane instead of recreating or cancelling the moved process', () => {
    const pending = structuredClone(terminal)
    if (pending.content?.kind !== 'terminal') {
      throw new Error('expected terminal')
    }
    pending.content.leaves[paneId]!.facts = {}
    repository.initialize('local', [pending])
    const target = startPendingPane()!
    repository.runs.beginRun(target, 'candidate')
    const move = {
      ...key,
      callerId: 'window',
      commandId: 'move',
      expiresAt: 1000,
      expected: repository.read(key)!,
      destination: { workspaceId: 'destination', hostTabId: 'tab', expected: null }
    }
    expect(repository.move(move).status).toBe('accepted')
    expect(repository.runs.beginRun(target, 'stale-candidate')).toEqual({
      status: 'conflict',
      code: 'allocation_changed'
    })
    const resource = { ptyId: 'candidate', incarnationId: 'child' }
    expect(repository.runs.bindRun('local', target.runId, resource)).toMatchObject({
      status: 'accepted',
      allocation: {
        decision: 'committed',
        target: { workspaceId: 'destination', runId: target.runId }
      }
    })
    expect(repository.read(key)?.content).toBeNull()
    expect(repository.read({ ...key, workspaceId: 'destination' })?.content).toMatchObject({
      leaves: { [paneId]: { runId: target.runId, facts: resource } }
    })
    expect(repository.move(move).status).toBe('accepted')
  })
})
