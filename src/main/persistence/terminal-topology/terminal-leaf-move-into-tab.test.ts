import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  A,
  B,
  C,
  FOLDER_WT,
  FROM,
  intoRequest,
  intoTabSession,
  localPartition,
  sleepingRecord,
  SOURCE,
  TARGET,
  TO,
  WT
} from './terminal-leaf-move-into-tab-fixture'
import { planTerminalLeafMoveIntoTab } from './terminal-leaf-move-into-tab'

function movedSession(
  session: WorkspaceSessionState,
  patch: Partial<typeof intoRequest> = {}
): WorkspaceSessionState {
  const planned = planTerminalLeafMoveIntoTab(localPartition(session), { ...intoRequest, ...patch })
  expect(planned.result.status).toBe('moved')
  expect(planned.sessions).toHaveLength(1)
  return planned.sessions[0]!.session
}

describe('a join into an existing tab (happy path)', () => {
  it('reports the moved PTY and that the source tab closed, rewriting one partition', () => {
    const planned = planTerminalLeafMoveIntoTab(localPartition(intoTabSession()), intoRequest)

    expect(planned.result).toEqual({ status: 'moved', ptyId: 'pty-a', sourceTabClosed: true })
    expect(planned.sessions.map(({ hostId }) => hostId)).toEqual(['local'])
    expect(planned.staleDroppedPtyIds).toEqual([])
  })

  it('R1/R5: grafts the leaf beside the target leaf on the requested side, active and uncollapsed', () => {
    const layout = movedSession(intoTabSession()).terminalLayoutsByTabId[TARGET]!

    expect(layout.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: B },
        second: { type: 'leaf', leafId: A }
      },
      second: { type: 'leaf', leafId: C }
    })
    expect(layout.activeLeafId).toBe(A)
    expect(layout.expandedLeafId).toBeNull()
  })

  it.each([
    ['left', 'vertical'],
    ['top', 'horizontal'],
    ['bottom', 'horizontal']
  ] as const)('R1: honours the %s edge', (side, direction) => {
    const root = movedSession(intoTabSession(), { placement: { kind: 'beside', side } })
      .terminalLayoutsByTabId[TARGET]!.root
    expect(root?.type === 'split' && root.first).toMatchObject({ type: 'split', direction })
  })

  it('R2/R3/R4: carries the PTY binding, title, buffer and scrollback ref', () => {
    const layout = movedSession(intoTabSession()).terminalLayoutsByTabId[TARGET]!

    expect(layout.ptyIdsByLeafId).toEqual({ [A]: 'pty-a', [B]: 'pty-b', [C]: 'pty-c' })
    expect(layout.titlesByLeafId).toEqual({ [A]: 'agent title', [B]: 'b title' })
    expect(layout.buffersByLeafId).toEqual({ [A]: 'buffer-a' })
    expect(layout.scrollbackRefsByLeafId).toEqual({ [A]: 'ref-a' })
  })

  it('R6: the target row keeps its pre-move primary PTY (one primary rule)', () => {
    const rows = movedSession(intoTabSession()).tabsByWorktree[WT]!

    expect(rows.map((tab) => [tab.id, tab.ptyId])).toEqual([[TARGET, 'pty-b']])
  })

  it('R7: the target remote session stays; the source entry goes with the source tab', () => {
    const session = movedSession(
      intoTabSession({ remoteSessionIdsByTabId: { [SOURCE]: 'pty-a', [TARGET]: 'pty-b' } })
    )

    expect(session.remoteSessionIdsByTabId).toEqual({ [TARGET]: 'pty-b' })
  })

  it('R8: the incarnation follows the pane, built from the original record', () => {
    const session = movedSession(intoTabSession())

    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [TO]: 'inc-a',
      [`${TARGET}:${B}`]: 'inc-b'
    })
  })

  it('R8: a partition whose copy names another PTY leaves its incarnation behind', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const stale = intoTabSession()
    stale.terminalLayoutsByTabId[SOURCE]!.ptyIdsByLeafId = { [A]: 'pty-old' }
    const planned = planTerminalLeafMoveIntoTab(
      [
        { hostId: 'local', session: intoTabSession() },
        { hostId: ssh, session: stale }
      ],
      intoRequest
    )

    const [local, remote] = planned.sessions.map(({ session }) => session)
    expect(local?.terminalPtyIncarnationsByPaneKey?.[TO]).toBe('inc-a')
    expect(remote?.terminalPtyIncarnationsByPaneKey?.[TO]).toBeUndefined()
    expect(remote?.terminalPtyIncarnationsByPaneKey?.[FROM]).toBeUndefined()
    expect(remote?.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe('pty-a')
  })

  it('R9: the sleeping record is re-keyed with its tabId before the source closes', () => {
    const session = movedSession(
      intoTabSession({ sleepingAgentSessionsByPaneKey: { [FROM]: sleepingRecord(FROM, SOURCE) } })
    )

    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [TO]: expect.objectContaining({ paneKey: TO, tabId: TARGET })
    })
  })

  it('R10/R11: the source closes in the same write with a tombstone and a revision advance', () => {
    const before = intoTabSession({ terminalTopologyRevisionByRepoId: { 'repo-1': 4 } })
    const session = movedSession(before)

    expect(session.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TARGET])
    expect(session.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual([TARGET])
    expect(session.tabGroups?.[WT]?.map((group) => group.id)).toEqual(['group-2'])
    expect(session.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: 'group-2' })
    expect(session.terminalLayoutsByTabId[SOURCE]).toBeUndefined()
    expect(session.closedTerminalTabTombstonesByTabId?.[SOURCE]).toMatchObject({
      worktreeId: WT,
      reason: 'cleanup'
    })
    expect(session.terminalTopologyRevisionByRepoId?.['repo-1']).toBeGreaterThan(4)
  })

  it('R11: a pinned source tab still closes (the drop is explicit)', () => {
    const session = intoTabSession()
    session.tabsByWorktree[WT]![0] = { ...session.tabsByWorktree[WT]![0]!, isPinned: true }
    session.unifiedTabs![WT]![0] = { ...session.unifiedTabs![WT]![0]!, isPinned: true }

    expect(movedSession(session).tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TARGET])
  })

  it('R12: local-only scrollback moves to the target tab', () => {
    const session = movedSession(
      intoTabSession({
        localOnlyScrollbackByTabId: { [SOURCE]: { [A]: 'local-a' }, [TARGET]: { [B]: 'local-b' } }
      })
    )

    expect(session.localOnlyScrollbackByTabId).toEqual({
      [TARGET]: { [A]: 'local-a', [B]: 'local-b' }
    })
  })

  it('R13: writes no pane tombstone for the moved pane or its PTY', () => {
    const session = movedSession(intoTabSession())

    expect(JSON.stringify(session.terminalSurfaceTombstonesByPaneKey ?? {})).not.toMatch(
      /tab-source:|pty-a/
    )
  })

  it('A3: after the move the leaf lives in exactly one live tab', () => {
    const session = movedSession(intoTabSession())
    const holders = Object.entries(session.terminalLayoutsByTabId)
      .filter(([, layout]) => collectLayoutLeafIdsInOrder(layout.root).includes(A))
      .map(([tabId]) => tabId)

    expect(holders).toEqual([TARGET])
  })

  it('does not mutate the sessions it read', () => {
    const session = intoTabSession()
    const snapshot = structuredClone(session)
    planTerminalLeafMoveIntoTab(localPartition(session), intoRequest)

    expect(session).toEqual(snapshot)
  })
})

describe('stale ids and PTY choice', () => {
  it('drops other PTY ids the source still names without killing them, and keeps the moved PTY', () => {
    const session = intoTabSession({ remoteSessionIdsByTabId: { [SOURCE]: 'pty-stale-remote' } })
    session.tabsByWorktree[WT]![0] = { ...session.tabsByWorktree[WT]![0]!, ptyId: 'pty-stale-row' }

    const planned = planTerminalLeafMoveIntoTab(localPartition(session), intoRequest)

    expect(planned.result).toMatchObject({ status: 'moved', ptyId: 'pty-a' })
    expect([...planned.staleDroppedPtyIds].sort()).toEqual(['pty-stale-remote', 'pty-stale-row'])
    const next = planned.sessions[0]!.session
    expect(next.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe('pty-a')
    expect(JSON.stringify(next)).not.toMatch(/pty-stale/)
  })

  it('follows the renderer PTY id when a partition still names the pre-respawn one', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const stale = intoTabSession()
    stale.terminalLayoutsByTabId[SOURCE]!.ptyIdsByLeafId = { [A]: 'pty-respawn' }
    const planned = planTerminalLeafMoveIntoTab(
      [
        { hostId: 'local', session: intoTabSession() },
        { hostId: ssh, session: stale }
      ],
      { ...intoRequest, ptyId: 'pty-respawn' }
    )

    expect(planned.result).toMatchObject({ status: 'moved', ptyId: 'pty-respawn' })
    for (const { session } of planned.sessions) {
      expect(session.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe('pty-respawn')
    }
  })

  it('uses the single bound PTY when the request names none', () => {
    const planned = planTerminalLeafMoveIntoTab(localPartition(intoTabSession()), {
      ...intoRequest,
      ptyId: null
    })

    expect(planned.result).toMatchObject({ status: 'moved', ptyId: 'pty-a' })
  })
})

describe('partitions and workspace kinds', () => {
  it('moves an SSH-only pane within its own partition', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const planned = planTerminalLeafMoveIntoTab(
      [{ hostId: ssh, session: intoTabSession() }],
      intoRequest
    )

    expect(planned.sessions.map(({ hostId }) => hostId)).toEqual([ssh])
  })

  it('rewrites every owner partition holding the pane and leaves runtime mirrors alone', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const mirror = intoTabSession()
    const planned = planTerminalLeafMoveIntoTab(
      [
        { hostId: 'local', session: intoTabSession() },
        { hostId: ssh, session: intoTabSession() },
        { hostId: 'runtime:env-1', session: mirror }
      ],
      intoRequest
    )

    expect(planned.sessions.map(({ hostId }) => hostId)).toEqual(['local', ssh])
    expect(mirror.terminalLayoutsByTabId[SOURCE]).toBeDefined()
  })

  it('works for a folder workspace, which has no git worktree behind its id', () => {
    const session = intoTabSession({}, FOLDER_WT)
    const planned = planTerminalLeafMoveIntoTab(localPartition(session), {
      ...intoRequest,
      worktreeId: FOLDER_WT
    })

    expect(planned.result.status).toBe('moved')
    const next = planned.sessions[0]!.session
    expect(next.tabsByWorktree[FOLDER_WT]?.map((tab) => tab.id)).toEqual([TARGET])
    expect(next.terminalTopologyRevisionByRepoId?.['repo-1']).toBe(1)
  })

  it('leaves legacy numeric pane keys alone', () => {
    const numeric = intoTabSession({
      terminalPtyIncarnationsByPaneKey: {
        [FROM]: 'inc-a',
        [`${SOURCE}:3`]: 'inc-legacy-source',
        [`${TARGET}:3`]: 'inc-legacy-target',
        'tab-other:3': 'inc-other'
      },
      sleepingAgentSessionsByPaneKey: {
        [`${TARGET}:3`]: sleepingRecord(`${TARGET}:3`, TARGET),
        'tab-other:3': sleepingRecord('tab-other:3', 'tab-other')
      }
    })
    const next = movedSession(numeric)

    expect(next.terminalPtyIncarnationsByPaneKey).toEqual({
      [TO]: 'inc-a',
      [`${SOURCE}:3`]: 'inc-legacy-source',
      [`${TARGET}:3`]: 'inc-legacy-target',
      'tab-other:3': 'inc-other'
    })
    expect(Object.keys(next.sleepingAgentSessionsByPaneKey ?? {}).sort()).toEqual(
      [`${TARGET}:3`, 'tab-other:3'].sort()
    )
  })
})
