import { describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTabObservation
} from '../../shared/remote-workspace-types'
import {
  MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET,
  RemoteWorkspaceTabIntentStore
} from './remote-workspace-tab-intent-store'

const TARGET = 'target-a'
const WORKTREE_ID = 'repo-a::/remote/work'
const WORKTREE_PATH = '/remote/work'

function tab(id: string, createdAt: number, ptyId = `pty-${id}`): RemoteWorkspaceObservedTab {
  return {
    processIdentity: JSON.stringify([ptyId, `incarnation-${ptyId}`]),
    tab: {
      id,
      worktreePath: WORKTREE_PATH,
      ptyId,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt
    }
  }
}

function observation(args: {
  renderer: string
  instance: string | null
  tabs: RemoteWorkspaceObservedTab[]
  targetId?: string
}): RemoteWorkspaceTabObservation {
  return {
    rendererInstanceId: args.renderer,
    targetId: args.targetId ?? TARGET,
    worktrees: [
      {
        worktreeId: WORKTREE_ID,
        worktreeInstanceId: args.instance,
        worktreePath: WORKTREE_PATH,
        tabs: args.tabs
      }
    ]
  }
}

function session(tabs: RemoteWorkspaceObservedTab[]): RemoteWorkspaceSession {
  return {
    activeWorktreePath: WORKTREE_PATH,
    activeTabId: tabs[0]?.tab.id ?? null,
    tabsByWorktreePath: { [WORKTREE_PATH]: tabs.map((entry) => entry.tab) },
    terminalLayoutsByTabId: {}
  }
}

function snapshot(revision: number, tabs: RemoteWorkspaceObservedTab[]): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: session(tabs)
  }
}

describe('RemoteWorkspaceTabIntentStore', () => {
  it('retains an unacknowledged creation across renderer restart until its patch returns', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const existing = tab('existing', 1)
    const created = tab('created', 2)
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [existing] }))
    store.observe(
      observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [existing, created] })
    )

    expect(
      store.reconcile(TARGET, snapshot(2, [existing]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([existing.tab, created.tab])

    store.observe(
      observation({ renderer: 'renderer-2', instance: 'worktree-1', tabs: [existing, created] })
    )
    expect(store.stateForTests(TARGET)?.intents).toBe(1)
    expect(
      store.reconcile(TARGET, snapshot(3, [existing]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([existing.tab, created.tab])

    const pushed = snapshot(4, [existing, created])
    const capture = store.capturePatch(TARGET, pushed.session)
    store.acknowledgePatch(TARGET, capture, { ok: true, snapshot: pushed })
    expect(store.stateForTests(TARGET)?.intents).toBe(0)
    expect(
      store.reconcile(TARGET, snapshot(5, [existing]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([existing.tab])
  })

  it('preserves a pre-delivery deletion without treating a matching notification as acknowledgement', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const deleted = tab('deleted', 1)
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [deleted] }))
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [] }))

    expect(
      store.reconcile(TARGET, snapshot(2, [deleted]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([])
    expect(store.reconcile(TARGET, snapshot(3, []))).not.toBeNull()
    expect(store.stateForTests(TARGET)?.intents).toBe(1)
  })

  it('does not let worktree and tab id reuse acknowledge an older workspace incarnation', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const reused = tab('same-tab', 1, 'pty-same')
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-old', tabs: [reused] }))
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-old', tabs: [] }))
    store.observe(observation({ renderer: 'renderer-2', instance: 'worktree-new', tabs: [reused] }))

    const coincidental = snapshot(2, [])
    const capture = store.capturePatch(TARGET, coincidental.session)
    store.acknowledgePatch(TARGET, capture, { ok: true, snapshot: coincidental })

    expect(store.stateForTests(TARGET)?.intents).toBe(1)
    expect(
      store.reconcile(TARGET, snapshot(3, [reused]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([reused.tab])
  })

  it('requires the current process identity before a reused tab slot can be acknowledged', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const first = tab('same-tab', 1, 'pty-old')
    const replacement = tab('same-tab', 1, 'pty-new')
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [first] }))
    store.observe(
      observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [replacement] })
    )

    const oldPatch = snapshot(2, [first])
    const capture = store.capturePatch(TARGET, oldPatch.session)
    store.acknowledgePatch(TARGET, capture, { ok: true, snapshot: oldPatch })

    expect(store.stateForTests(TARGET)?.intents).toBe(1)
    expect(
      store.reconcile(TARGET, snapshot(3, [first]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([replacement.tab])
  })

  it('fails closed on overflow until an exact causal full-session patch returns', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const tabs = Array.from(
      { length: MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET + 1 },
      (_, index) => tab(`tab-${index}`, index)
    )
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs }))
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [] }))

    expect(store.reconcile(TARGET, snapshot(2, tabs))).toBeNull()
    const empty = snapshot(3, [])
    const capture = store.capturePatch(TARGET, empty.session)
    store.acknowledgePatch(TARGET, capture, { ok: true, snapshot: empty })
    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: false })
  })

  it('keeps targets isolated and clears only explicitly removed target state', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const existing = tab('existing', 1)
    const created = tab('created', 2)
    store.observe(observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [existing] }))
    store.observe(
      observation({ renderer: 'renderer-1', instance: 'worktree-1', tabs: [existing, created] })
    )
    store.observe(
      observation({
        renderer: 'renderer-1',
        instance: 'worktree-b',
        tabs: [],
        targetId: 'target-b'
      })
    )

    expect(store.reconcile('target-b', snapshot(2, [existing]))).toEqual(snapshot(2, [existing]))
    store.forgetTarget(TARGET)
    expect(store.stateForTests(TARGET)).toBeNull()
  })
})
