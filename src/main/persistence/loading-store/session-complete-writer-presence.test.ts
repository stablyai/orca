import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import type { SessionMapField } from '../../../shared/session-change-set'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTerminalTabInWorkspaceSession } from '../../../shared/workspace-session-terminal-tab-close'
import {
  addWorkspace,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { prepareSessionOperation } from './session-operation'
import { reduceReusedTerminalBinding } from './reused-terminal-id-unbind'
import { applyPtyBinding } from './pty-binding-session-update'
import { clearReplacedPaneBinding } from './replaced-pane-binding'

const tabId = 'terminal-1'
const paneKey = `${tabId}:${leaf(1)}`
function initial(): WorkspaceSessionState {
  const root = getDefaultWorkspaceSession()
  addWorkspace(root, GIT_KEY, [{ id: 'group', tabs: [{ id: tabId, leaves: [[leaf(1), 'pty']] }] }])
  return root
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}
const writers: readonly {
  name: string
  field: SessionMapField
  seed(root: WorkspaceSessionState): void
  run(root: WorkspaceSessionState): WorkspaceSessionState
  native(root: WorkspaceSessionState): unknown
  present(root: WorkspaceSessionState): boolean
}[] = [
  {
    name: 'terminal close',
    field: 'sleepingAgentSessionsByPaneKey',
    seed: (root) => {
      root.sleepingAgentSessionsByPaneKey = {
        [paneKey]: {
          paneKey,
          tabId,
          worktreeId: GIT_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 's' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    },
    run: (root) => closeTerminalTabInWorkspaceSession(root, GIT_KEY, tabId).session,
    native: (root) =>
      Object.fromEntries(
        Object.entries(root.sleepingAgentSessionsByPaneKey ?? {}).filter(
          ([key, record]) => !key.startsWith(`${tabId}:`) && record.tabId !== tabId
        )
      ),
    present: () => true
  },
  {
    name: 'PTY retirement',
    field: 'terminalPtyIncarnationsByPaneKey',
    seed: (root) => {
      root.terminalPtyIncarnationsByPaneKey = { [paneKey]: 'old' }
    },
    run: (root) =>
      prepareSessionOperation(
        root,
        { type: 'retirePty', owner: GIT_KEY, tabId, leafId: leaf(1), ptyId: 'pty' },
        new SessionUnitIndex(root)
      ).snapshot(),
    native: (root) =>
      clearReplacedPaneBinding(root, {
        worktreeId: GIT_KEY,
        parentTabId: tabId,
        leafId: leaf(1),
        ptyId: 'pty'
      }).terminalPtyIncarnationsByPaneKey,
    present: () => true
  },
  {
    name: 'binding incarnation clear',
    field: 'terminalPtyIncarnationsByPaneKey',
    seed: (root) => {
      root.terminalPtyIncarnationsByPaneKey = { [paneKey]: 'old' }
    },
    run: (root) =>
      applyPtyBinding(
        { worktreeId: GIT_KEY, tabId, leafId: leaf(1), ptyId: 'pty', dropsIncarnation: true },
        root,
        GIT_KEY,
        paneKey
      ),
    native: (root) =>
      root.terminalPtyIncarnationsByPaneKey &&
      Object.fromEntries(
        Object.entries(root.terminalPtyIncarnationsByPaneKey).filter(([key]) => key !== paneKey)
      ),
    present: (root) => Object.hasOwn(root, 'terminalPtyIncarnationsByPaneKey')
  },
  ...(['removeOwners', 'removeRepo'] as const).flatMap((type) =>
    (
      [
        'terminalPtyIncarnationsByPaneKey',
        ...(type === 'removeOwners'
          ? (['sleepingAgentSessionsByPaneKey', 'closedTerminalTabTombstonesByTabId'] as const)
          : [])
      ] as const
    ).map((field) => ({
      name: `${type} / ${field}`,
      field,
      seed: (root: WorkspaceSessionState) => {
        if (field === 'terminalPtyIncarnationsByPaneKey') {
          root[field] = { [paneKey]: 'old' }
        } else if (field === 'closedTerminalTabTombstonesByTabId') {
          root[field] = { [tabId]: { worktreeId: GIT_KEY, closedAt: 1 } }
        } else {
          root[field] = {
            [paneKey]: {
              paneKey,
              tabId,
              worktreeId: GIT_KEY,
              agent: 'codex',
              providerSession: { key: 'session_id', id: 's' },
              prompt: '',
              state: 'working',
              capturedAt: 1,
              updatedAt: 1
            }
          }
        }
      },
      run: (root: WorkspaceSessionState) =>
        prepareSessionOperation(
          root,
          type === 'removeOwners'
            ? { type, owners: [GIT_KEY], advanceRevision: false }
            : { type, repoId: 'repo-1' },
          new SessionUnitIndex(root)
        ).snapshot(),
      native: (root: WorkspaceSessionState) => (root[field] === undefined ? undefined : {}),
      present: (root: WorkspaceSessionState) => Object.hasOwn(root, field)
    }))
  )
]

describe('complete writers retain native field construction', () => {
  for (const writer of writers) {
    for (const populated of [false, true]) {
      it(`${writer.name}: ${populated ? 'last entry removed' : 'field absent before'}`, () => {
        const root = initial()
        if (populated) {
          writer.seed(root)
        }
        const saved = structuredClone(root)
        freeze(root)
        const next = writer.run(root)
        expect(Object.hasOwn(next, writer.field)).toBe(writer.present(saved))
        expect(next[writer.field]).toStrictEqual(writer.native(saved))
        expect(root).toStrictEqual(saved)
      })
    }
  }
  it('reused PTY unbinding keeps the native explicit empty incarnation Record', () => {
    const root = initial()
    root.terminalPtyIncarnationsByPaneKey = { [paneKey]: 'old' }
    freeze(root)
    const reader = new SessionUnitReader(root, new SessionUnitIndex(root))
    expect(
      reduceReusedTerminalBinding(reader, {
        ptyId: 'pty',
        incarnationId: 'new',
        tabId: 'successor',
        leafId: leaf(2)
      })
    ).toBe(true)
    expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toStrictEqual({})
    expect(root.terminalPtyIncarnationsByPaneKey).toStrictEqual({ [paneKey]: 'old' })
  })
})
