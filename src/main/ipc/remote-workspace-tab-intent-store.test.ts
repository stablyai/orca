import { describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTabObservation
} from '../../shared/remote-workspace-types'
import {
  MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET,
  MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS,
  MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS,
  RemoteWorkspaceTabIntentStore
} from './remote-workspace-tab-intent-store'
import { MAX_REMOTE_WORKSPACE_OBSERVATION_BYTES_PER_TARGET } from './remote-workspace-tab-observation-bounds'

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
  authoritative?: boolean
  connected?: boolean
  generation: number
  hydrated?: boolean
  instance: string | null
  tabs: RemoteWorkspaceObservedTab[]
  targetId?: string
}): RemoteWorkspaceTabObservation {
  return {
    ...(args.authoritative ? { authoritative: true } : {}),
    ...(args.connected === undefined ? {} : { connected: args.connected }),
    hydrated: args.hydrated ?? true,
    rendererGeneration: args.generation,
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

function authority(generation: number, senderId = 1, processId = 10) {
  return { processId, rendererGeneration: generation, senderId }
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
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing, created] })
    )

    expect(
      store.reconcile(TARGET, snapshot(2, [existing]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([existing.tab, created.tab])

    store.observe(
      authority(2, 1, 11),
      observation({ generation: 2, instance: 'worktree-1', tabs: [existing, created] })
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
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [deleted] })
    )
    store.observe(authority(1), observation({ generation: 1, instance: 'worktree-1', tabs: [] }))

    expect(
      store.reconcile(TARGET, snapshot(2, [deleted]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([])
    expect(store.reconcile(TARGET, snapshot(3, []))).not.toBeNull()
    expect(store.stateForTests(TARGET)?.intents).toBe(1)
  })

  it('does not let worktree and tab id reuse acknowledge an older workspace incarnation', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const reused = tab('same-tab', 1, 'pty-same')
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-old', tabs: [reused] })
    )
    store.observe(authority(1), observation({ generation: 1, instance: 'worktree-old', tabs: [] }))
    store.observe(
      authority(2, 1, 11),
      observation({ generation: 2, instance: 'worktree-new', tabs: [reused] })
    )

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
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [first] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [replacement] })
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
    store.observe(authority(1), observation({ generation: 1, instance: 'worktree-1', tabs }))
    store.observe(authority(1), observation({ generation: 1, instance: 'worktree-1', tabs: [] }))

    expect(store.reconcile(TARGET, snapshot(2, tabs))).toBeNull()
    const empty = snapshot(3, [])
    const capture = store.capturePatch(TARGET, empty.session)
    store.acknowledgePatch(TARGET, capture, { ok: true, snapshot: empty })
    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: false })
  })

  it('bounds retained tab layouts per target and recovers through a bounded full observation', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const created = tab('created', 1)
    store.observe(
      authority(1),
      observation({
        authoritative: true,
        generation: 1,
        instance: 'worktree-1',
        tabs: []
      })
    )
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-1',
        tabs: [
          {
            ...created,
            layout: {
              activeLeafId: 'leaf',
              buffersByLeafId: {
                leaf: 'x'.repeat(MAX_REMOTE_WORKSPACE_OBSERVATION_BYTES_PER_TARGET)
              },
              expandedLeafId: null,
              root: null
            }
          }
        ]
      })
    )

    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: true })
    expect(store.reconcile(TARGET, snapshot(2, []))).toBeNull()
    const oversizedCapture = store.capturePatch(TARGET, snapshot(3, [created]).session)
    store.acknowledgePatch(TARGET, oversizedCapture, {
      ok: true,
      snapshot: snapshot(3, [created])
    })
    expect(store.stateForTests(TARGET)?.overflowed).toBe(true)

    store.observe(
      authority(1),
      observation({
        authoritative: true,
        generation: 1,
        instance: 'worktree-1',
        tabs: [created]
      })
    )
    const bounded = snapshot(4, [created])
    const boundedCapture = store.capturePatch(TARGET, bounded.session)
    store.acknowledgePatch(TARGET, boundedCapture, { ok: true, snapshot: bounded })
    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: false })
  })

  it('keeps targets isolated and clears only explicitly removed target state', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const existing = tab('existing', 1)
    const created = tab('created', 2)
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing, created] })
    )
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-b',
        tabs: [],
        targetId: 'target-b'
      })
    )

    expect(store.reconcile('target-b', snapshot(2, [existing]))).toEqual(snapshot(2, [existing]))
    store.forgetTarget(TARGET, authority(1))
    expect(store.stateForTests(TARGET)).toBeNull()
  })

  it('rejects a queued acknowledgement captured before target forget and readmission', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const created = tab('created', 1)
    store.observe(
      authority(1),
      observation({ authoritative: true, generation: 1, instance: 'worktree-1', tabs: [] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [created] })
    )
    const pushed = snapshot(2, [created])
    const staleCapture = store.capturePatch(TARGET, pushed.session)

    store.forgetTarget(TARGET, authority(1))
    store.observe(
      authority(1),
      observation({ authoritative: true, generation: 1, instance: 'worktree-1', tabs: [] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [created] })
    )
    store.acknowledgePatch(TARGET, staleCapture, { ok: true, snapshot: pushed })

    expect(store.stateForTests(TARGET)).toEqual({ intents: 1, overflowed: false })
    expect(
      store.reconcile(TARGET, snapshot(3, []))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([created.tab])
  })

  it('ignores pre-hydration emptiness before accepting the post-snapshot baseline', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const staleLocal = tab('deleted-remotely', 1)
    store.observe(
      authority(1),
      observation({ generation: 1, hydrated: false, instance: 'worktree-1', tabs: [] })
    )
    expect(store.stateForTests(TARGET)).toBeNull()

    store.observe(authority(1), observation({ generation: 1, instance: 'worktree-1', tabs: [] }))
    expect(store.reconcile(TARGET, snapshot(2, [staleLocal]))).toEqual(snapshot(2, [staleLocal]))
    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: false })
  })

  it('rejects an older renderer generation after a process-owned takeover', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const existing = tab('existing', 1)
    const staleCreation = tab('stale-creation', 2)
    store.observe(
      authority(1, 1, 10),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing] })
    )
    store.observe(
      authority(2, 1, 11),
      observation({ generation: 2, instance: 'worktree-1', tabs: [existing] })
    )
    store.observe(
      authority(1, 1, 10),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing, staleCreation] })
    )

    expect(store.stateForTests(TARGET)).toEqual({ intents: 0, overflowed: false })
    expect(store.reconcile(TARGET, snapshot(2, [existing]))).toEqual(snapshot(2, [existing]))
    store.forgetTarget(TARGET, authority(1, 1, 10))
    expect(store.stateForTests(TARGET)).not.toBeNull()
    store.forgetTarget(TARGET, authority(3, 1, 12))
    expect(store.stateForTests(TARGET)).toBeNull()
  })

  it('contains target admission overflow and recovers capacity after owner cleanup', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const existing = tab('existing', 1)
    const created = tab('created', 2)
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing] })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-1', tabs: [existing, created] })
    )
    for (let index = 1; index < MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
    }
    for (let index = MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index < 1_000; index += 1) {
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
    }

    expect(
      store.reconcile(TARGET, snapshot(2, [existing]))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([existing.tab, created.tab])
    expect(store.reconcile('target-999', snapshot(2, [existing]))).toEqual(snapshot(2, [existing]))

    store.forgetTarget('target-1', authority(1))
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-999',
        tabs: [existing],
        targetId: 'target-999'
      })
    )
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-999',
        tabs: [existing, created],
        targetId: 'target-999'
      })
    )
    expect(
      store.reconcile('target-999', snapshot(3, [existing]))?.session.tabsByWorktreePath[
        WORKTREE_PATH
      ]
    ).toEqual([existing.tab, created.tab])
  })

  it('protects target 65 deletion acknowledgement and unsolicited creation', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const deleted = tab('deleted', 1)
    const created = tab('created', 2)
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
    }

    store.observe(
      authority(1),
      observation({
        authoritative: true,
        generation: 1,
        instance: 'worktree-65',
        tabs: [deleted],
        targetId: 'target-65'
      })
    )
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-65', tabs: [], targetId: 'target-65' })
    )
    expect(
      store.reconcile('target-65', snapshot(2, [deleted]))?.session.tabsByWorktreePath[
        WORKTREE_PATH
      ]
    ).toEqual([])

    const acknowledgedDeletion = snapshot(3, [])
    const capture = store.capturePatch('target-65', acknowledgedDeletion.session)
    store.acknowledgePatch('target-65', capture, {
      ok: true,
      snapshot: acknowledgedDeletion
    })
    expect(store.stateForTests('target-65')).toEqual({ intents: 0, overflowed: false })

    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-65',
        tabs: [created],
        targetId: 'target-65'
      })
    )
    expect(
      store.reconcile('target-65', snapshot(4, []))?.session.tabsByWorktreePath[WORKTREE_PATH]
    ).toEqual([created.tab])
  })

  it('evicts an idle disconnected baseline before connected targets', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          connected: index !== MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
    }

    store.observe(
      authority(1),
      observation({
        authoritative: true,
        connected: true,
        generation: 1,
        instance: 'worktree-65',
        tabs: [],
        targetId: 'target-65'
      })
    )

    expect(store.stateForTests('target-1')).not.toBeNull()
    expect(store.stateForTests(`target-${MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS}`)).toBeNull()
    expect(store.stateForTests('target-65')).toEqual({ intents: 0, overflowed: false })

    store.observe(
      authority(1),
      observation({
        authoritative: true,
        connected: false,
        generation: 1,
        instance: 'worktree-66',
        tabs: [],
        targetId: 'target-66'
      })
    )
    expect(store.stateForTests('target-66')).toBeNull()
  })

  it('uses connection-only observations for admission, eviction, and cleanup', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          connected: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
    }

    store.observe(
      authority(1),
      observation({
        connected: false,
        generation: 1,
        instance: `worktree-${MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS}`,
        tabs: [],
        targetId: `target-${MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS}`
      })
    )
    store.observe(
      authority(1),
      observation({
        authoritative: true,
        connected: true,
        generation: 1,
        instance: 'worktree-65',
        tabs: [],
        targetId: 'target-65'
      })
    )

    expect(store.stateForTests(`target-${MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS}`)).toBeNull()
    expect(store.stateForTests('target-65')).toEqual({ intents: 0, overflowed: false })

    store.forgetTarget('target-65', authority(1))
    expect(store.stateForTests('target-65')).toBeNull()

    store.observe(
      authority(1),
      observation({
        authoritative: true,
        connected: false,
        generation: 1,
        instance: 'worktree-66',
        tabs: [],
        targetId: 'target-66'
      })
    )
    expect(store.stateForTests('target-66')).toEqual({ intents: 0, overflowed: false })
  })

  it('fails target-local reconciliation closed when every retained target is pending', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      const created = tab(`created-${index}`, index)
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
      store.observe(
        authority(1),
        observation({
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [created],
          targetId: `target-${index}`
        })
      )
    }

    const target65Tab = tab('created-65', 65)
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-65',
        tabs: [target65Tab],
        targetId: 'target-65'
      })
    )
    expect(store.hasPending('target-65')).toBe(true)
    expect(store.reconcile('target-65', snapshot(2, []))).toBeNull()

    const acknowledged = snapshot(3, [target65Tab])
    const capture = store.capturePatch('target-65', acknowledged.session)
    expect(capture.untracked).not.toBeNull()
    store.acknowledgePatch('target-65', capture, { ok: true, snapshot: acknowledged })
    expect(store.hasPending('target-65')).toBe(false)
    expect(store.reconcile('target-65', acknowledged)).toEqual(acknowledged)
  })

  it('recovers secondary overflow after authoritative all-target cleanup', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      const retained = tab(`retained-${index}`, index)
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
      store.observe(
        authority(1),
        observation({
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [retained],
          targetId: `target-${index}`
        })
      )
    }
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS + 1; index += 1) {
      store.observe(
        authority(1),
        observation({
          generation: 1,
          instance: `overflow-${index}`,
          tabs: [tab(`overflow-${index}`, index)],
          targetId: `overflow-${index}`
        })
      )
    }

    expect(store.hasPending('never-observed')).toBe(true)
    store.forgetAll(authority(1))
    expect(store.hasPending('never-observed')).toBe(false)
    expect(store.stateForTests('target-1')).toBeNull()
  })

  it('keeps a newer untracked mutation pending when an older patch is acknowledged', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    for (let index = 1; index <= MAX_REMOTE_WORKSPACE_TAB_INTENT_TARGETS; index += 1) {
      const retained = tab(`retained-${index}`, index)
      store.observe(
        authority(1),
        observation({
          authoritative: true,
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [],
          targetId: `target-${index}`
        })
      )
      store.observe(
        authority(1),
        observation({
          generation: 1,
          instance: `worktree-${index}`,
          tabs: [retained],
          targetId: `target-${index}`
        })
      )
    }

    const first = tab('first', 65)
    const later = tab('later', 66)
    store.observe(
      authority(1),
      observation({ generation: 1, instance: 'worktree-65', tabs: [first], targetId: 'target-65' })
    )
    const olderPatch = snapshot(2, [first])
    const olderCapture = store.capturePatch('target-65', olderPatch.session)
    expect(olderCapture.untracked).not.toBeNull()
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-65',
        tabs: [first, later],
        targetId: 'target-65'
      })
    )

    store.acknowledgePatch('target-65', olderCapture, { ok: true, snapshot: olderPatch })

    expect(store.hasPending('target-65')).toBe(true)
    expect(store.reconcile('target-65', olderPatch)).toBeNull()

    const laterPatch = snapshot(3, [first, later])
    const laterCapture = store.capturePatch('target-65', laterPatch.session)
    const afterRestart = tab('after-restart', 67)
    store.observe(
      authority(2, 2, 11),
      observation({
        generation: 2,
        instance: 'worktree-65',
        tabs: [first, later, afterRestart],
        targetId: 'target-65'
      })
    )
    store.acknowledgePatch('target-65', laterCapture, { ok: true, snapshot: laterPatch })
    expect(store.hasPending('target-65')).toBe(true)
  })

  it('rejects oversized target ids before retaining fail-closed state', () => {
    const store = new RemoteWorkspaceTabIntentStore()
    const oversizedTargetId = 'x'.repeat(1024 * 1024)

    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-oversized',
        tabs: [],
        targetId: oversizedTargetId
      })
    )

    expect(store.stateForTests(oversizedTargetId)).toBeNull()
    expect(store.hasPending(oversizedTargetId)).toBe(false)

    const multibyteOversizedTargetId = '🦀'.repeat(129)
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-multibyte',
        tabs: [],
        targetId: multibyteOversizedTargetId
      })
    )
    expect(store.stateForTests(multibyteOversizedTargetId)).toBeNull()

    const boundaryTargetId = 'v'.repeat(512)
    store.observe(
      authority(1),
      observation({
        generation: 1,
        instance: 'worktree-boundary',
        tabs: [],
        targetId: boundaryTargetId
      })
    )
    expect(store.stateForTests(boundaryTargetId)).toEqual({ intents: 0, overflowed: false })
  })
})
