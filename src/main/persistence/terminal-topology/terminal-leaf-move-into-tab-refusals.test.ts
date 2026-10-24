import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { TerminalLeafIntoTabResult } from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { makeTerminalTab } from '../../persistence-session-fixtures'
import {
  A,
  B,
  C,
  intoRequest,
  intoTabSession,
  localPartition,
  SOURCE,
  TARGET,
  WT
} from './terminal-leaf-move-into-tab-fixture'
import { planTerminalLeafMoveIntoTab } from './terminal-leaf-move-into-tab'
import type { TerminalSessionPartition } from './terminal-topology-membership'

function refusalOf(
  partitions: TerminalSessionPartition[],
  patch: Partial<typeof intoRequest> = {}
): TerminalLeafIntoTabResult {
  const planned = planTerminalLeafMoveIntoTab(partitions, { ...intoRequest, ...patch })
  // A refusal writes nothing: the commit sees no partition to rewrite.
  expect(planned.sessions).toEqual([])
  return planned.result
}

function withTabRow(
  session: WorkspaceSessionState,
  tabId: string,
  patch: Partial<ReturnType<typeof makeTerminalTab>>
): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: {
      [WT]: (session.tabsByWorktree[WT] ?? []).map((tab) =>
        tab.id === tabId ? { ...tab, ...patch } : tab
      )
    }
  }
}

describe('a join into an existing tab refuses', () => {
  it('source_not_single_leaf unless the source layout is exactly the moved leaf', () => {
    const session = intoTabSession()
    session.terminalLayoutsByTabId[SOURCE] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: C }
      },
      activeLeafId: A,
      expandedLeafId: null,
      ptyIdsByLeafId: { [A]: 'pty-a', [C]: 'pty-sibling' }
    }
    expect(refusalOf(localPartition(session))).toEqual({
      status: 'refused',
      reason: 'source_not_single_leaf'
    })
  })

  it('source_not_single_leaf when only one holder partition shows a split source', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const split = intoTabSession()
    split.terminalLayoutsByTabId[SOURCE] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: '44444444-4444-4444-8444-444444444444' }
      },
      activeLeafId: A,
      expandedLeafId: null
    }
    const partitions = [
      { hostId: 'local' as const, session: intoTabSession() },
      { hostId: ssh, session: split }
    ]
    expect(refusalOf(partitions)).toEqual({ status: 'refused', reason: 'source_not_single_leaf' })
  })

  it('source_is_chat for a chat leaf and for a chat-view source tab', () => {
    const chatLeaf = intoTabSession()
    chatLeaf.terminalLayoutsByTabId[SOURCE] = {
      ...chatLeaf.terminalLayoutsByTabId[SOURCE]!,
      chatLeafId: A
    }
    expect(refusalOf(localPartition(chatLeaf))).toEqual({
      status: 'refused',
      reason: 'source_is_chat'
    })
    const chatTab = withTabRow(intoTabSession(), SOURCE, { viewMode: 'chat' })
    expect(refusalOf(localPartition(chatTab))).toEqual({
      status: 'refused',
      reason: 'source_is_chat'
    })
  })

  it('source_launch_pending while the leaf has an unfinished agent launch', () => {
    const pending = withTabRow(intoTabSession(), SOURCE, { agentLaunchPane: { leafId: A } })
    expect(refusalOf(localPartition(pending))).toEqual({
      status: 'refused',
      reason: 'source_launch_pending'
    })
    const finished = withTabRow(intoTabSession(), SOURCE, {
      agentLaunchPane: { leafId: A, outcome: { kind: 'unconfirmed' } }
    })
    const planned = planTerminalLeafMoveIntoTab(localPartition(finished), intoRequest)
    expect(planned.result.status).toBe('moved')
  })

  it('target_tab_missing when the target tab is in no owner partition', () => {
    const session = intoTabSession()
    session.tabsByWorktree[WT] = session.tabsByWorktree[WT]!.filter((tab) => tab.id !== TARGET)
    expect(refusalOf(localPartition(session))).toEqual({
      status: 'refused',
      reason: 'target_tab_missing'
    })
  })

  it('target_leaf_missing when main no longer holds the target leaf', () => {
    expect(
      refusalOf(localPartition(intoTabSession()), {
        targetLeafId: '55555555-5555-4555-8555-555555555555'
      })
    ).toEqual({ status: 'refused', reason: 'target_leaf_missing' })
    const noLayout = intoTabSession()
    delete noLayout.terminalLayoutsByTabId[TARGET]
    expect(refusalOf(localPartition(noLayout))).toEqual({
      status: 'refused',
      reason: 'target_leaf_missing'
    })
  })

  it('target_is_chat when the target tab shows its chat view', () => {
    const session = withTabRow(intoTabSession(), TARGET, { viewMode: 'chat' })
    expect(refusalOf(localPartition(session))).toEqual({
      status: 'refused',
      reason: 'target_is_chat'
    })
  })

  it('partition_mismatch when a partition holding the source lacks the target', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const sourceOnly = intoTabSession()
    sourceOnly.tabsByWorktree[WT] = sourceOnly.tabsByWorktree[WT]!.filter(
      (tab) => tab.id !== TARGET
    )
    delete sourceOnly.terminalLayoutsByTabId[TARGET]
    const partitions = [
      { hostId: 'local' as const, session: intoTabSession() },
      { hostId: ssh, session: sourceOnly }
    ]
    expect(refusalOf(partitions)).toEqual({ status: 'refused', reason: 'partition_mismatch' })
  })

  it('partition_mismatch when a holder lacks the target leaf although another has it', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const withoutLeaf = intoTabSession()
    withoutLeaf.terminalLayoutsByTabId[TARGET] = {
      root: { type: 'leaf', leafId: C },
      activeLeafId: C,
      expandedLeafId: null
    }
    const partitions = [
      { hostId: 'local' as const, session: intoTabSession() },
      { hostId: ssh, session: withoutLeaf }
    ]
    expect(refusalOf(partitions)).toEqual({ status: 'refused', reason: 'partition_mismatch' })
  })

  it('partition_mismatch when a non-holder partition lists only the target tab', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    // local never saw the source: it keeps a target tab that would lack the moved leaf.
    const targetOnly = intoTabSession()
    targetOnly.tabsByWorktree[WT] = targetOnly.tabsByWorktree[WT]!.filter(
      (tab) => tab.id !== SOURCE
    )
    delete targetOnly.terminalLayoutsByTabId[SOURCE]
    const partitions = [
      { hostId: 'local' as const, session: targetOnly },
      { hostId: ssh, session: intoTabSession() }
    ]
    expect(refusalOf(partitions)).toEqual({ status: 'refused', reason: 'partition_mismatch' })
  })

  it('partition_mismatch when a non-holder partition keeps a source row without the leaf', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    // That row would survive the move as a ghost tab.
    const ghost = intoTabSession()
    ghost.terminalLayoutsByTabId[SOURCE] = {
      root: { type: 'leaf', leafId: C },
      activeLeafId: C,
      expandedLeafId: null
    }
    const partitions = [
      { hostId: 'local' as const, session: intoTabSession() },
      { hostId: ssh, session: ghost }
    ]
    expect(refusalOf(partitions)).toEqual({ status: 'refused', reason: 'partition_mismatch' })
  })

  it('moves when a non-holder owner partition lists neither tab', () => {
    const ssh = toSshExecutionHostId('ssh-1')
    const unrelated = intoTabSession()
    unrelated.tabsByWorktree[WT] = []
    unrelated.terminalLayoutsByTabId = {}
    const planned = planTerminalLeafMoveIntoTab(
      [
        { hostId: 'local' as const, session: intoTabSession() },
        { hostId: ssh, session: unrelated }
      ],
      intoRequest
    )
    expect(planned.result.status).toBe('moved')
  })

  it('leaf_in_other_tab while a third live tab, or the target, already holds the leaf', () => {
    const third = intoTabSession()
    third.tabsByWorktree[WT] = [
      ...third.tabsByWorktree[WT]!,
      makeTerminalTab({ id: 'tab-third', worktreeId: WT })
    ]
    third.terminalLayoutsByTabId['tab-third'] = {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null
    }
    expect(refusalOf(localPartition(third))).toEqual({
      status: 'refused',
      reason: 'leaf_in_other_tab'
    })

    const inTarget = intoTabSession()
    inTarget.terminalLayoutsByTabId[TARGET] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: B },
        second: { type: 'leaf', leafId: A }
      },
      activeLeafId: B,
      expandedLeafId: null
    }
    expect(refusalOf(localPartition(inTarget))).toEqual({
      status: 'refused',
      reason: 'leaf_in_other_tab'
    })
  })

  it('pty_mismatch when the renderer names another terminal than the bound one', () => {
    expect(refusalOf(localPartition(intoTabSession()), { ptyId: 'pty-other' })).toEqual({
      status: 'refused',
      reason: 'pty_mismatch'
    })
  })

  it('pty_missing when neither the request nor main names a PTY for the leaf', () => {
    const session = intoTabSession()
    session.terminalLayoutsByTabId[SOURCE] = {
      root: { type: 'leaf', leafId: A },
      activeLeafId: A,
      expandedLeafId: null
    }
    expect(refusalOf(localPartition(session), { ptyId: null })).toEqual({
      status: 'refused',
      reason: 'pty_missing'
    })
  })

  it('not_held, not a refusal, when main never saw the source leaf', () => {
    const session = intoTabSession()
    delete session.terminalLayoutsByTabId[SOURCE]
    expect(refusalOf(localPartition(session))).toEqual({ status: 'not_held' })
  })

  it('not_held when only a runtime mirror partition holds the source', () => {
    const runtime = { hostId: toRuntimeExecutionHostId('env-1'), session: intoTabSession() }
    expect(refusalOf([runtime])).toEqual({ status: 'not_held' })
  })
})
