import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import {
  createSessionOwnerFixture,
  SESSION_OWNER_WORKTREE_ID as id
} from './runtime-session-owner.test-fixture'

function legacyFrame(snapshot: RuntimeMobileSessionTabsSnapshot) {
  const { worktreeIdentity: _owner, worktreeInstanceId: _instance, ...frame } = snapshot
  return { ...frame, publicationEpoch: 'renderer:old', snapshotVersion: 1 }
}

async function recreateFromOldRenderer() {
  const f = createSessionOwnerFixture(false, false)
  await f.list('b')
  const current = f.runtime.current()
  if (!current) {
    throw new Error('Missing old publication')
  }
  const old = legacyFrame(current)
  f.runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    rendererGeneration: 'renderer:old',
    mobileSessionTabs: [old]
  })
  f.runtime.retire('b')
  const successor = f.store.setWorktreeMetaForHost(id, 'ssh:session-b', {})
  return { f, old, successor }
}

describe('session owner admission preserves removed-renderer fences', () => {
  it('a checked unique subscriber receives its own removal tombstone', async () => {
    const f = createSessionOwnerFixture(false, false)
    const frames: unknown[] = []
    await f.dispatcher.dispatchStreaming(
      {
        id: 'removed-stream-b',
        authToken: 'test',
        method: 'session.tabs.subscribe',
        params: { worktree: `identity:${f.identity('b').key}` }
      },
      (message) => frames.push(JSON.parse(message)),
      { connectionId: 'removed-session-client', clientKind: 'runtime' }
    )
    expect(frames).toHaveLength(1)
    f.runtime.retire('b')
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({
      result: { type: 'updated', worktree: id, worktreeIdentity: f.identity('b'), removed: true }
    })
    f.runtime.cleanupSubscriptionsForConnection('removed-session-client')
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('a retired checked stream never receives a successor occupant removal', async () => {
    const f = createSessionOwnerFixture(false, false)
    const frames: unknown[] = []
    await f.dispatcher.dispatchStreaming(
      {
        id: 'old-b',
        authToken: 'test',
        method: 'session.tabs.subscribe',
        params: { worktree: `identity:${f.identity('b').key}` }
      },
      (message) => frames.push(JSON.parse(message)),
      { connectionId: 'old-b-client', clientKind: 'runtime' }
    )
    const old = f.runtime.current()
    if (!old) {
      throw new Error('Missing original publication')
    }
    f.runtime.retire('b')
    expect(frames).toHaveLength(2)
    const meta = f.store.setWorktreeMetaForHost(id, 'ssh:session-b', {})
    if (!meta.instanceId) {
      throw new Error('Missing successor occupant')
    }
    const successor = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'ssh:session-b',
      instanceId: meta.instanceId
    })
    f.runtime.publish({
      ...old,
      worktreeIdentity: successor,
      worktreeInstanceId: successor.instanceId,
      publicationEpoch: 'renderer:successor'
    })
    expect(f.runtime.current()?.worktreeIdentity).toEqual(successor)
    f.runtime.retire('b')
    expect(frames).toHaveLength(2)
    f.runtime.cleanupSubscriptionsForConnection('old-b-client')
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('keeps a unique legacy ID subscriber receiving removal frames', async () => {
    const f = createSessionOwnerFixture(false, false)
    const frames: unknown[] = []
    await f.dispatcher.dispatchStreaming(
      {
        id: 'legacy-b',
        authToken: 'test',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${id}` }
      },
      (message) => frames.push(JSON.parse(message)),
      { connectionId: 'legacy-b-client' }
    )
    expect(frames).toHaveLength(1)
    f.runtime.retire('b')
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ result: { worktree: id, removed: true } })
    f.runtime.cleanupSubscriptionsForConnection('legacy-b-client')
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('cannot turn an old identity-less frame into proof of the successor occupant', async () => {
    const { f, old } = await recreateFromOldRenderer()
    expect(f.runtime.current()).toBeUndefined()
    f.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:old',
      mobileSessionTabs: [{ ...old, snapshotVersion: 2 }]
    })
    expect(f.runtime.current()).toBeUndefined()
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('accepts the actually supplied current instance after the same-ID recreation', async () => {
    const { f, old, successor } = await recreateFromOldRenderer()
    f.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:old',
      mobileSessionTabs: [{ ...old, worktreeInstanceId: successor.instanceId, snapshotVersion: 2 }]
    })
    expect(f.runtime.current()).toMatchObject({
      worktreeInstanceId: successor.instanceId,
      worktreeIdentity: { executionHostId: 'ssh:session-b', instanceId: successor.instanceId }
    })
    expect(f.kill).not.toHaveBeenCalled()
  })
})
