import { describe, expect, it } from 'vitest'
import { createHudStore, type HudState } from './hud-store'
import { NotificationInboxController } from './notification-inbox-state'
import type { RpcPort, RpcResponse } from '../transport/orca-rpc-wire'

function fixtureState(rows: HudState['dashboard']['rows'] = []): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows, fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

class FakeRpcPort implements RpcPort {
  onData: ((result: unknown) => void) | null = null
  unsubscribed = false

  sendRequest(): Promise<RpcResponse> {
    throw new Error('not used by notification-inbox-state')
  }

  subscribe(method: string, _params: unknown, onData: (result: unknown) => void): () => void {
    expect(method).toBe('notifications.subscribe')
    this.onData = onData
    return () => {
      this.unsubscribed = true
    }
  }
}

describe('NotificationInboxController', () => {
  it('ignores the ready event', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    new NotificationInboxController(store, { port }).start()

    port.onData?.({ type: 'ready', subscriptionId: 'sub-1' })

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

  it('start() returns the port unsubscribe fn', () => {
    const store = createHudStore(fixtureState())
    const port = new FakeRpcPort()
    const unsubscribe = new NotificationInboxController(store, { port }).start()

    unsubscribe()

    expect(port.unsubscribed).toBe(true)
  })
})
