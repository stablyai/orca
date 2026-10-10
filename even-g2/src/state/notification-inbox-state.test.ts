import { describe, expect, it } from 'vitest'
import { createHudStore, type HudState } from './hud-store'
import { currentAsk, NotificationInboxController } from './notification-inbox-state'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'

function fixtureState(rows: HudState['dashboard']['rows'] = []): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows, fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

class FakeRpcPort implements RpcPort {
  onData: ((result: unknown) => void) | null = null
  unsubscribed = false
  sendRequestCalls: { method: string; params?: unknown }[] = []
  sendRequestQueue: (RpcResponse | Error)[] = []

  sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
    this.sendRequestCalls.push({ method, params })
    const next = this.sendRequestQueue.shift()
    if (next instanceof Error) {
      return Promise.reject(next)
    }
    if (!next) {
      return Promise.reject(new Error('no response queued'))
    }
    return Promise.resolve(next)
  }

  subscribe(method: string, _params: unknown, onData: (result: unknown) => void): () => void {
    expect(method).toBe('notifications.subscribe')
    this.onData = onData
    return () => {
      this.unsubscribed = true
    }
  }
}

function okMissedResponse(notifications: unknown[], epoch?: string): RpcResponse {
  return { id: '1', ok: true, result: { notifications, epoch }, _meta: { runtimeId: 'test' } }
}

describe('NotificationInboxController', () => {
  it('ignores the ready event', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })

    expect(store.getState().inbox.entries).toEqual([])
  })

  it('derives kind "done" for agent-task-complete when worktree is not waiting on permission', () => {
    const store = createHudStore(
      fixtureState([{ worktreeId: 'w1', displayName: 'api', status: 'working' }])
    )
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port, now: () => 42 }).start()

    port.onData?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished the refactor',
      worktreeId: 'w1',
      notificationId: 'n1'
    })

    expect(store.getState().inbox.entries).toEqual([
      {
        notificationId: 'n1',
        title: 'Done',
        body: 'Finished the refactor',
        worktreeId: 'w1',
        receivedAt: 42,
        kind: 'done'
      }
    ])
  })

  it('derives kind "info" for terminal-bell', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({
      type: 'notification',
      source: 'terminal-bell',
      title: 'Bell',
      body: 'ding',
      notificationId: 'n2'
    })

    expect(store.getState().inbox.entries[0]?.kind).toBe('info')
  })

  it('derives kind "ask" when the notification worktree status is permission, overriding source', () => {
    const store = createHudStore(
      fixtureState([{ worktreeId: 'w1', displayName: 'api', status: 'permission' }])
    )
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({
      type: 'notification',
      source: 'terminal-bell',
      title: 'Needs input',
      body: 'Approve?',
      worktreeId: 'w1',
      notificationId: 'n3'
    })

    expect(store.getState().inbox.entries[0]?.kind).toBe('ask')
  })

  it('removes an entry on dismiss', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({
      type: 'notification',
      source: 'test',
      title: 't',
      body: 'b',
      notificationId: 'n4'
    })
    expect(store.getState().inbox.entries).toHaveLength(1)

    port.onData?.({ type: 'dismiss', notificationId: 'n4' })
    expect(store.getState().inbox.entries).toEqual([])
  })

  it('bounds the ring buffer to the last 20 entries', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    for (let i = 0; i < 25; i++) {
      port.onData?.({
        type: 'notification',
        source: 'test',
        title: `t${i}`,
        body: 'b',
        notificationId: `n${i}`
      })
    }

    const entries = store.getState().inbox.entries
    expect(entries).toHaveLength(20)
    expect(entries[0]?.notificationId).toBe('n5') // oldest 5 dropped
    expect(entries[19]?.notificationId).toBe('n24')
  })

  it('generates a local id when notificationId is absent', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({ type: 'notification', source: 'test', title: 't', body: 'b' })

    expect(store.getState().inbox.entries[0]?.notificationId).toMatch(/^local-/)
  })

  it('start() returns a fn that unsubscribes the port', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const unsubscribe = new NotificationInboxController(store, { port }).start()

    unsubscribe()

    expect(port.unsubscribed).toBe(true)
  })

  describe('classification race (HIGH fix): reclassify retained entries once the dashboard catches up', () => {
    it('upgrades a stuck "info" entry to "ask" once the dashboard later reports permission', () => {
      // Notification arrives BEFORE the first worktree.ps poll has ever populated dashboard.rows.
      const store = createHudStore(fixtureState([]))
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input',
        body: 'Approve?',
        worktreeId: 'w1',
        notificationId: 'n1'
      })
      expect(store.getState().inbox.entries[0]?.kind).toBe('info') // wrong, but that's the race

      // The dashboard poll lands afterward and reveals the worktree was actually waiting.
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'api', status: 'permission' }],
          fetchedAt: 1,
          stale: false
        }
      }))

      expect(store.getState().inbox.entries[0]?.kind).toBe('ask')
    })

    it('does not touch entries without a worktreeId or already classified as ask', () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'notification', source: 'test', title: 't', body: 'b' }) // no worktreeId
      const before = store.getState().inbox.entries[0]

      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'api', status: 'permission' }],
          fetchedAt: 1,
          stale: false
        }
      }))

      expect(store.getState().inbox.entries[0]).toEqual(before)
    })
  })

  describe('reconnect backfill (MEDIUM fix): notifications.getMissedSince on resubscribe', () => {
    it('does not backfill on the first ready (cold start — nothing missed yet)', () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })

      expect(port.sendRequestCalls).toEqual([])
    })

    it('calls getMissedSince with the watermark on a resubscribe and appends the missed entries', async () => {
      const store = createHudStore(
        fixtureState([{ worktreeId: 'w1', displayName: 'api', status: 'working' }])
      )
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port, now: () => 100 }).start()

      port.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' }) // cold start
      port.onData?.({
        type: 'notification',
        source: 'test',
        title: 'live',
        body: 'b',
        notificationId: 'n-live',
        notificationSeq: 5,
        notificationEpoch: 'epoch-1'
      })

      port.sendRequestQueue.push(
        okMissedResponse(
          [
            {
              source: 'agent-task-complete',
              title: 'Missed while offline',
              body: 'Finished',
              worktreeId: 'w1',
              notificationId: 'n-missed',
              notificationSeq: 6,
              notificationEpoch: 'epoch-1'
            }
          ],
          'epoch-1'
        )
      )
      port.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' }) // resubscribe after reconnect
      await Promise.resolve()
      await Promise.resolve()

      expect(port.sendRequestCalls).toEqual([
        { method: 'notifications.getMissedSince', params: { lastSeenSeq: 5, epoch: 'epoch-1' } }
      ])
      const ids = store.getState().inbox.entries.map((e) => e.notificationId)
      expect(ids).toEqual(['n-live', 'n-missed'])
      expect(store.getState().inbox.entries[1]).toEqual({
        notificationId: 'n-missed',
        title: 'Missed while offline',
        body: 'Finished',
        worktreeId: 'w1',
        receivedAt: 100,
        kind: 'done'
      })
    })

    it('degrades safely when the host omits notifications.getMissedSince (ok:false response)', async () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'ready' }) // cold start, no epoch metadata at all
      port.sendRequestQueue.push({
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'unknown method' },
        _meta: { runtimeId: 'test' }
      })
      port.onData?.({ type: 'ready' }) // resubscribe
      await Promise.resolve()
      await Promise.resolve()

      expect(store.getState().inbox.entries).toEqual([])
    })

    it('degrades safely when the sendRequest call rejects outright (transport failure)', async () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'ready' })
      port.sendRequestQueue.push(new Error('socket closed mid-request'))
      port.onData?.({ type: 'ready' })
      await Promise.resolve()
      await Promise.resolve()

      expect(store.getState().inbox.entries).toEqual([])
    })

    it('finding #7: resets the watermark on a new notificationEpoch so getMissedSince never uses a stale high seq', async () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'ready', epoch: 'epoch-1' }) // cold start
      port.onData?.({
        type: 'notification',
        source: 'test',
        title: 'old epoch',
        body: 'b',
        notificationId: 'n-old',
        notificationSeq: 50,
        notificationEpoch: 'epoch-1'
      })
      // Host restarted: new epoch, sequence restarts from 0-ish — a LOWER seq than before.
      port.onData?.({
        type: 'notification',
        source: 'test',
        title: 'new epoch',
        body: 'b',
        notificationId: 'n-new',
        notificationSeq: 2,
        notificationEpoch: 'epoch-2'
      })

      port.sendRequestQueue.push(okMissedResponse([], 'epoch-2'))
      port.onData?.({ type: 'ready', epoch: 'epoch-2' }) // resubscribe after reconnect
      await Promise.resolve()
      await Promise.resolve()

      // Without the reset, this would carry over seq 50 and silently miss anything the host
      // dispatched between seq 2 and 50 in the NEW epoch.
      expect(port.sendRequestCalls).toEqual([
        { method: 'notifications.getMissedSince', params: { lastSeenSeq: 2, epoch: 'epoch-2' } }
      ])
    })

    it('skips malformed missed items instead of throwing', async () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port }).start()

      port.onData?.({ type: 'ready' })
      port.sendRequestQueue.push(okMissedResponse([{ notificationId: 'bad-no-title-or-body' }]))
      port.onData?.({ type: 'ready' })
      await Promise.resolve()
      await Promise.resolve()

      expect(store.getState().inbox.entries).toEqual([])
    })
  })

  describe('dedupe by notificationId (finding #13)', () => {
    it('replaces an existing entry instead of appending a duplicate', () => {
      const store = createHudStore(fixtureState())
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port, now: () => 1 }).start()

      port.onData?.({
        type: 'notification',
        source: 'test',
        title: 'first',
        body: 'b1',
        notificationId: 'dup'
      })
      port.onData?.({
        type: 'notification',
        source: 'test',
        title: 'redelivered',
        body: 'b2',
        notificationId: 'dup'
      })

      const entries = store.getState().inbox.entries
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ notificationId: 'dup', title: 'redelivered', body: 'b2' })
    })
  })

  describe('redelivery preserves a retirement tombstone (finding #4)', () => {
    it('does not un-retire an already-retired notificationId on redelivery', () => {
      const store = createHudStore(
        fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }])
      )
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port, now: () => 1 }).start()
      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input',
        body: 'Approve?',
        worktreeId: 'w1',
        notificationId: 'n1'
      })
      expect(store.getState().inbox.entries[0]?.kind).toBe('ask')

      // Worktree leaves permission with no fresh notification — 'n1' is retired.
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'w1', status: 'working' }],
          fetchedAt: 2,
          stale: false
        }
      }))
      expect(store.getState().inbox.entries[0]).toMatchObject({ kind: 'info', retiredAsk: true })

      // A redelivery of the SAME notificationId (getMissedSince overlap, duplicate retry) while
      // the worktree is still NOT `permission` — toEntry classifies the fresh copy as 'info',
      // which the reclassifier's kind==='ask' gate would never touch, so ONLY upsertEntry's own
      // tombstone-preservation stands between this and a silently resurrected ask.
      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input',
        body: 'Approve?',
        worktreeId: 'w1',
        notificationId: 'n1'
      })
      expect(store.getState().inbox.entries[0]).toMatchObject({ kind: 'info', retiredAsk: true })
    })
  })

  describe('permission-episode membership (finding #4)', () => {
    it('does not promote an old "done" notification to ask for a brand-new permission episode', () => {
      let now = 10
      const store = createHudStore(
        fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'working' }])
      )
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port, now: () => now }).start()

      port.onData?.({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'Done',
        body: 'Finished an earlier task',
        worktreeId: 'w1',
        notificationId: 'done-1'
      })
      expect(store.getState().inbox.entries[0]?.kind).toBe('done')

      // Time passes; a brand-new wait begins well after that old completion notification.
      now = 100
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }],
          fetchedAt: 100,
          stale: false
        }
      }))

      // The stale 'done' notification must never stand in as this episode's ask — fall through
      // to synthesis (finding #14) until the new episode's own notification arrives.
      expect(currentAsk(store.getState())).toEqual({
        notificationId: 'synthetic-ask:w1',
        worktreeId: 'w1'
      })
      expect(store.getState().inbox.entries[0]?.kind).toBe('done') // never mutated into 'ask'

      // Once THIS episode's own notification lands, it becomes the ask — not the old one.
      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input',
        body: 'Approve?',
        worktreeId: 'w1',
        notificationId: 'ask-1'
      })
      expect(currentAsk(store.getState())).toEqual({ notificationId: 'ask-1', worktreeId: 'w1' })
    })
  })

  describe('currentAsk (findings #13/#14)', () => {
    it('returns null when no worktree is in permission', () => {
      const state = fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'working' }])
      expect(currentAsk(state)).toBeNull()
    })

    it('returns the entry tied to the worktree currently in permission', () => {
      const state: HudState = {
        ...fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }]),
        inbox: {
          entries: [
            {
              notificationId: 'n1',
              title: 't',
              body: 'b',
              worktreeId: 'w1',
              receivedAt: 1,
              kind: 'ask'
            }
          ]
        }
      }
      expect(currentAsk(state)).toEqual({ notificationId: 'n1', worktreeId: 'w1' })
    })

    it('finding #13: ignores a historical (retired) entry, not the current episode', () => {
      const state: HudState = {
        ...fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }]),
        inbox: {
          entries: [
            {
              notificationId: 'old',
              title: 'old episode',
              body: 'b',
              worktreeId: 'w1',
              receivedAt: 1,
              kind: 'info',
              retiredAsk: true
            }
          ]
        }
      }
      // No live entry for the current episode — falls through to synthesis rather than
      // resurrecting the retired one.
      expect(currentAsk(state)).toEqual({ notificationId: 'synthetic-ask:w1', worktreeId: 'w1' })
    })

    it('finding #14: synthesizes an ask for a blocked worktree with no notification at all', () => {
      const state = fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }])
      expect(currentAsk(state)).toEqual({ notificationId: 'synthetic-ask:w1', worktreeId: 'w1' })
    })
  })

  describe('reclassification retires a superseded ask (finding #13)', () => {
    it('retires the ask once its worktree leaves permission, permanently (never resurrects it)', () => {
      const store = createHudStore(
        fixtureState([{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }])
      )
      const port = new FakeRpcPort()
      new NotificationInboxController(store, { port, now: () => 1 }).start()
      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input',
        body: 'Approve?',
        worktreeId: 'w1',
        notificationId: 'n1'
      })
      expect(store.getState().inbox.entries[0]?.kind).toBe('ask')

      // The agent gets answered; the worktree leaves permission with no fresh notification.
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'w1', status: 'working' }],
          fetchedAt: 2,
          stale: false
        }
      }))
      expect(store.getState().inbox.entries[0]).toMatchObject({ kind: 'info', retiredAsk: true })

      // A later, unrelated permission episode on the SAME worktree must not resurrect the old
      // notification as the "current" ask (finding #13) — currentAsk should synthesize instead.
      store.update((s) => ({
        ...s,
        dashboard: {
          rows: [{ worktreeId: 'w1', displayName: 'w1', status: 'permission' }],
          fetchedAt: 3,
          stale: false
        }
      }))
      expect(store.getState().inbox.entries[0]).toMatchObject({ kind: 'info', retiredAsk: true })
      expect(currentAsk(store.getState())).toEqual({
        notificationId: 'synthetic-ask:w1',
        worktreeId: 'w1'
      })

      // Once the new episode's own notification arrives, it — not the retired one — becomes ask.
      port.onData?.({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Needs input again',
        body: 'Approve again?',
        worktreeId: 'w1',
        notificationId: 'n2'
      })
      expect(currentAsk(store.getState())).toEqual({ notificationId: 'n2', worktreeId: 'w1' })
    })
  })
})
