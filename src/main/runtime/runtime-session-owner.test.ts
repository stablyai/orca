import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  createSessionOwnerFixture,
  SESSION_OWNER_WORKTREE_ID as id,
  sessionOwnerDeferred
} from './runtime-session-owner.test-fixture'

async function subscribeEmptyOwner(f: ReturnType<typeof createSessionOwnerFixture>, raw: string) {
  const frames: unknown[] = []
  await f.dispatcher.dispatchStreaming(
    {
      id: `stream-empty-${raw}`,
      authToken: 'test',
      method: 'session.tabs.subscribe',
      params: { worktree: `identity:${f.identity(raw).key}` }
    },
    (message) => frames.push(JSON.parse(message)),
    { connectionId: 'empty-session-client', clientKind: 'runtime' }
  )
  return frames
}

describe('registered session requests retain the resolved checkout owner', () => {
  it('a known current runtime occupant cannot relabel a rotated saved partition', async () => {
    const f = createSessionOwnerFixture(false, false)
    const previous = f.store.getWorkspaceSession('ssh:session-b')
    previous.tabsByWorktree[id] = previous.tabsByWorktree[id]!.map((tab) => ({
      ...tab,
      ptyId: toAppSshPtyId('session-b', `saved-${tab.id}`)
    }))
    f.store.setWorkspaceSession(previous, 'ssh:session-b')
    f.store.updateRepo('repo-session-owner', { executionHostId: 'runtime:current' })
    const meta = f.store.setWorktreeMetaForHost(id, 'runtime:current', {})
    if (!meta.instanceId) {
      throw new Error('Missing current runtime occupant')
    }
    const owner = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'runtime:current',
      instanceId: meta.instanceId
    })
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'runtime:current')
    f.runtime.sync([])
    expect(f.runtime.current()).toBeUndefined()
    expect(
      await f.dispatcher.dispatch({
        id: 'known-runtime-owner',
        authToken: 'test',
        method: 'session.tabs.list',
        params: { worktree: `id:${id}` }
      })
    ).toMatchObject({ ok: true, result: { worktreeIdentity: owner, tabs: [] } })
    expect(f.store.getWorkspaceSession('ssh:session-b').tabsByWorktree[id]).toEqual(
      previous.tabsByWorktree[id]
    )
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('empty B keeps its exact answer when A owns the cached nonempty publication', async () => {
    const f = createSessionOwnerFixture()
    const empty = getDefaultWorkspaceSession()
    empty.tabsByWorktree[id] = []
    f.store.setWorkspaceSession(empty, 'ssh:session-b')
    await f.list('a')
    const admittedA = f.runtime.current()
    const response = await f.list('b')
    expect(response).toMatchObject({
      ok: true,
      result: { worktreeIdentity: f.identity('b'), tabs: [] }
    })
    expect(f.runtime.current()).toBe(admittedA)
    expect(f.kill).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'keeps A/B/A saved layouts and retirement proofs separate, reversed:%s',
    async (reversed) => {
      const f = createSessionOwnerFixture(reversed)
      await f.list('a')
      const a = f.runtime.current()
      if (!a) {
        throw new Error('Missing admitted A snapshot')
      }
      f.runtime.publish({
        ...a,
        retiredTerminalSurfaces: [
          {
            parentTabId: 'retired-a',
            leafId: 'retired-leaf',
            ptyId: 'retired-pty',
            terminal: 'retired-handle'
          }
        ]
      })
      const b = await f.list('b')
      expect(b).toMatchObject({
        ok: true,
        result: {
          worktreeIdentity: f.identity('b'),
          tabs: [
            expect.objectContaining({ parentTabId: 'tab-b-1' }),
            expect.objectContaining({ parentTabId: 'tab-b-2' })
          ],
          tabGroupLayout: { first: { groupId: 'group-b-1' }, second: { groupId: 'group-b-2' } }
        }
      })
      expect(f.runtime.current()?.retiredTerminalSurfaces).toBeUndefined()
      const again = await f.list('a')
      expect(again).toMatchObject({
        ok: true,
        result: {
          worktreeIdentity: f.identity('a'),
          tabs: [
            expect.objectContaining({ parentTabId: 'tab-a-1' }),
            expect.objectContaining({ parentTabId: 'tab-a-2' })
          ]
        }
      })
      expect(
        f.store.getWorkspaceSession('ssh:session-a').tabsByWorktree[id]?.map((tab) => tab.id)
      ).toEqual(['tab-a-1', 'tab-a-2'])
      expect(
        f.store.getWorkspaceSession('ssh:session-b').tabsByWorktree[id]?.map((tab) => tab.id)
      ).toEqual(['tab-b-1', 'tab-b-2'])
    }
  )

  it('returns each own answer when A/B requests overlap the inventory await', async () => {
    const f = createSessionOwnerFixture()
    const gate = sessionOwnerDeferred()
    f.inventory.mockReturnValueOnce(gate.promise)
    const pendingA = f.list('a')
    await expect.poll(() => f.inventory.mock.calls.length).toBe(1)
    expect(await f.list('b')).toMatchObject({
      ok: true,
      result: {
        worktreeIdentity: f.identity('b'),
        tabs: [expect.objectContaining({ parentTabId: 'tab-b-1' }), expect.anything()]
      }
    })
    gate.release()
    expect(await pendingA).toMatchObject({
      ok: true,
      result: {
        worktreeIdentity: f.identity('a'),
        tabs: [expect.objectContaining({ parentTabId: 'tab-a-1' }), expect.anything()]
      }
    })
    expect(f.inventory.mock.calls.map(([connectionId]) => connectionId)).toEqual([
      'session-a',
      'session-b'
    ])
    expect(f.kill).not.toHaveBeenCalled()
  })

  it('refuses retirement during inventory without replacing the admitted other owner', async () => {
    const f = createSessionOwnerFixture()
    const gate = sessionOwnerDeferred()
    f.inventory.mockReturnValueOnce(gate.promise)
    const pendingA = f.list('a')
    await expect.poll(() => f.inventory.mock.calls.length).toBe(1)
    await f.list('b')
    const admittedB = f.runtime.current()
    f.store.setWorktreeMetaForHost(id, 'ssh:session-a', { instanceId: randomUUID() })
    gate.release()
    expect(await pendingA).toMatchObject({ ok: false, error: { message: 'selector_not_found' } })
    expect(f.runtime.current()).toBe(admittedB)
    expect(f.kill).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'unqualified graph sync cannot overwrite or prune checked B, reversed:%s',
    async (reversed) => {
      const f = createSessionOwnerFixture(reversed)
      await f.list('b')
      const admittedB = f.runtime.current()
      if (!admittedB) {
        throw new Error('Missing admitted B')
      }
      const { worktreeIdentity: _owner, worktreeInstanceId: _instance, ...legacy } = admittedB
      f.runtime.sync([{ ...legacy, publicationEpoch: 'unknown-a', tabs: [] }])
      f.runtime.sync([])
      f.runtime.registerRescuePane('a')
      f.runtime.rescue()
      expect(f.runtime.current()).toBe(admittedB)
      expect(await f.list('b')).toMatchObject({
        ok: true,
        result: {
          worktreeIdentity: f.identity('b'),
          tabs: [expect.objectContaining({ parentTabId: 'tab-b-1' }), expect.anything()]
        }
      })
    }
  )

  it('raw twins sharing an instance still select distinct saved partitions', async () => {
    const f = createSessionOwnerFixture()
    const instanceId = f.identity('a').instanceId
    f.store.setWorktreeMetaForHost(id, 'ssh:session-b', { instanceId })
    f.runtime.invalidateWorktreeCatalog('repo-session-owner')
    const ownerB = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'ssh:session-b',
      instanceId
    })
    await f.list('a')
    const response = await f.dispatcher.dispatch({
      id: 'same-instance',
      authToken: 'test',
      method: 'session.tabs.list',
      params: { worktree: `identity:${ownerB.key}` }
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        worktreeIdentity: ownerB,
        tabs: [expect.objectContaining({ parentTabId: 'tab-b-1' }), expect.anything()]
      }
    })
  })

  it('an unknown legacy producer cannot overwrite or prune a captured publication', async () => {
    const f = createSessionOwnerFixture()
    await f.list('b')
    const admitted = f.runtime.current()
    if (!admitted) {
      throw new Error('Missing captured publication')
    }
    const { worktreeIdentity: _owner, worktreeInstanceId: _instance, ...legacy } = admitted
    const catalog = vi.spyOn(f.store, 'getRepos').mockReturnValue([])
    f.runtime.publish({ ...legacy, publicationEpoch: 'unknown', tabs: [] })
    f.runtime.sync([{ ...legacy, publicationEpoch: 'unknown', tabs: [] }])
    f.runtime.sync([])
    f.runtime.registerRescuePane('a')
    f.runtime.rescue()
    expect(f.runtime.current()).toBe(admitted)
    expect(
      await f.dispatcher.dispatch({
        id: 'unknown-legacy',
        authToken: 'test',
        method: 'session.tabs.list',
        params: { worktree: `id:${id}` }
      })
    ).toMatchObject({ ok: false, error: { message: 'selector_not_found' } })
    catalog.mockRestore()
    expect(await f.list('b')).toMatchObject({
      ok: true,
      result: { worktreeIdentity: f.identity('b') }
    })
  })

  it('a new instance on the same raw host excludes its predecessor cache and proofs', async () => {
    const f = createSessionOwnerFixture()
    await f.list('b')
    const old = f.runtime.current()
    if (!old) {
      throw new Error('Missing predecessor snapshot')
    }
    f.runtime.publish({
      ...old,
      retiredTerminalSurfaces: [
        { parentTabId: 'old-tab', leafId: 'old-leaf', ptyId: 'old-pty', terminal: 'old-handle' }
      ]
    })
    const instanceId = randomUUID()
    f.store.setWorktreeMetaForHost(id, 'ssh:session-b', { instanceId })
    f.runtime.invalidateWorktreeCatalog('repo-session-owner')
    const successor = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'ssh:session-b',
      instanceId
    })
    const response = await f.dispatcher.dispatch({
      id: 'successor',
      authToken: 'test',
      method: 'session.tabs.list',
      params: { worktree: `identity:${successor.key}` }
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        worktreeIdentity: successor,
        tabs: [expect.objectContaining({ parentTabId: 'tab-b-1' }), expect.anything()]
      }
    })
    expect(f.runtime.current()?.retiredTerminalSurfaces).toBeUndefined()
    const admitted = f.runtime.current()
    f.runtime.publish(old)
    expect(f.runtime.current()).toBe(admitted)
    expect(await f.list('b')).toMatchObject({ ok: false, error: { message: 'selector_not_found' } })
  })

  it('same-epoch renderer frames from another raw owner do not inherit acceptance ordering', async () => {
    const f = createSessionOwnerFixture()
    await f.list('a')
    const a = f.runtime.current()
    if (!a) {
      throw new Error('Missing A')
    }
    f.runtime.sync([{ ...a, publicationEpoch: 'shared-epoch', snapshotVersion: 20 }])
    await f.list('b')
    const b = f.runtime.current()
    if (!b) {
      throw new Error('Missing B')
    }
    f.runtime.sync([{ ...b, publicationEpoch: 'shared-epoch', snapshotVersion: 1 }])
    expect(f.runtime.current()?.publicationEpoch).toBe('shared-epoch')
    expect(f.runtime.current()?.worktreeIdentity).toEqual(f.identity('b'))
  })

  it('a legacy bare ID refuses twins and preserves the admitted publication', async () => {
    const f = createSessionOwnerFixture()
    await f.list('b')
    const admitted = f.runtime.current()
    const response = await f.dispatcher.dispatch({
      id: 'legacy',
      authToken: 'test',
      method: 'session.tabs.list',
      params: { worktree: `id:${id}` }
    })
    expect(response).toMatchObject({ ok: false, error: { message: 'selector_ambiguous' } })
    expect(f.runtime.current()).toBe(admitted)
  })

  it('a unique legacy caller keeps the bare locator and gets optional owner data', async () => {
    const f = createSessionOwnerFixture(false, false)
    const response = await f.dispatcher.dispatch({
      id: 'legacy-unique',
      authToken: 'test',
      method: 'session.tabs.list',
      params: { worktree: `id:${id}` }
    })
    expect(response).toMatchObject({
      ok: true,
      result: { worktree: id, worktreeIdentity: f.identity('b') }
    })
  })

  it('a uniquely owned registered rescue pane still augments its own publication', async () => {
    const f = createSessionOwnerFixture(false, false)
    await f.list('b')
    f.runtime.registerRescuePane('b')
    f.runtime.rescue()
    expect(f.runtime.current()?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentTabId: 'rescue-tab-b', ptyId: 'rescue-b' })
      ])
    )
    expect(f.runtime.current()?.worktreeIdentity).toEqual(f.identity('b'))
  })

  it('a qualified A stream never emits B after B is listed and notified', async () => {
    const f = createSessionOwnerFixture()
    const frames: unknown[] = []
    await f.dispatcher.dispatchStreaming(
      {
        id: 'stream-a',
        authToken: 'test',
        method: 'session.tabs.subscribe',
        params: { worktree: `identity:${f.identity('a').key}` }
      },
      (message) => frames.push(JSON.parse(message)),
      { connectionId: 'session-client', clientKind: 'runtime' }
    )
    const initialCount = frames.length
    expect(initialCount).toBeGreaterThan(0)
    await f.list('b')
    f.runtime.notify()
    expect(frames).toHaveLength(initialCount)
    await f.list('a')
    f.runtime.notify()
    expect(frames.length).toBeGreaterThan(initialCount)
    f.runtime.cleanupSubscriptionsForConnection('session-client')
  })

  it('a checked empty subscriber receives its answer when the graph first publishes', async () => {
    const f = createSessionOwnerFixture(false, false, false)
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:session-b')
    const frames = await subscribeEmptyOwner(f, 'b')
    expect(frames).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          type: 'snapshot',
          worktreeIdentity: f.identity('b'),
          publicationEpoch: 'none',
          tabs: []
        })
      })
    ])
    f.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({
      result: { type: 'updated', worktreeIdentity: f.identity('b'), tabs: [] }
    })
    f.runtime.cleanupSubscriptionsForConnection('empty-session-client')
  })

  it('empty A/B startup waiters each publish once despite repeated same-owner reads', async () => {
    const f = createSessionOwnerFixture(false, true, false)
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:session-a')
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:session-b')
    const a = await subscribeEmptyOwner(f, 'a')
    const b = await subscribeEmptyOwner(f, 'b')
    await f.list('a')
    await f.list('b')
    f.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(a[1]).toMatchObject({ result: { worktreeIdentity: f.identity('a'), tabs: [] } })
    expect(b[1]).toMatchObject({ result: { worktreeIdentity: f.identity('b'), tabs: [] } })
    f.runtime.cleanupSubscriptionsForConnection('empty-session-client')
  })

  it('startup publication refuses a captured empty occupant retired during the wait', async () => {
    const f = createSessionOwnerFixture(false, false, false)
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:session-b')
    const frames = await subscribeEmptyOwner(f, 'b')
    f.store.setWorktreeMetaForHost(id, 'ssh:session-b', { instanceId: randomUUID() })
    f.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(frames).toHaveLength(1)
    expect(f.kill).not.toHaveBeenCalled()
    f.runtime.cleanupSubscriptionsForConnection('empty-session-client')
  })

  it('cached A cannot hide the first published empty answer for checked B', async () => {
    const f = createSessionOwnerFixture(false, true, false)
    f.store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:session-b')
    await f.list('a')
    const admittedA = f.runtime.current()
    const frames = await subscribeEmptyOwner(f, 'b')
    f.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ result: { worktreeIdentity: f.identity('b'), tabs: [] } })
    expect(f.runtime.current()).toBe(admittedA)
    expect(f.kill).not.toHaveBeenCalled()
    f.runtime.cleanupSubscriptionsForConnection('empty-session-client')
  })
})
