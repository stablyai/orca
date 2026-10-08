import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import {
  composesDesktopTabs,
  scopeRpcClientToExecutionHost
} from './execution-host-scoped-rpc-client'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

const SERVER = 'runtime:env-1' as const
const PARAMS = { worktree: 'id:w' }

const serverSnapshot = {
  type: 'snapshot',
  worktree: 'w',
  publicationEpoch: 'headless:1',
  snapshotVersion: 1,
  activeTabId: 't1::a',
  activeTabType: 'terminal',
  tabs: [{ type: 'terminal', id: 't1::a', parentTabId: 't1', isActive: true }]
}

function desktopSnapshot(type: 'snapshot' | 'updated', version: number) {
  return {
    type,
    worktree: 'w',
    publicationEpoch: 'renderer:1',
    snapshotVersion: version,
    activeTabId: 'e1',
    activeTabType: 'file',
    tabGroups: [{ id: 'g', activeTabId: 'e1', tabOrder: ['e1'], desktopTabOrder: ['e1', 't1'] }],
    tabs: [{ type: 'file', id: 'e1', filePath: '/a.ts', isActive: true }]
  }
}

/** The paired desktop's client: records where each call ran, and lets a test drive both streams. */
function fakeDesktopClient() {
  const listeners = new Map<string, (frame: unknown) => void>()
  const requests: { method: string; executionHost: string | undefined }[] = []
  const state = { desktopFails: false }
  const reply = (result: unknown): RpcResponse => ({ id: 'r', ok: true, result })
  const client: RpcClient = {
    sendRequest: vi.fn(async (method, _params, options) => {
      requests.push({ method, executionHost: options?.executionHost })
      if (options?.executionHost) {
        return reply(serverSnapshot)
      }
      if (state.desktopFails) {
        throw new Error('desktop unreachable')
      }
      return reply(desktopSnapshot('snapshot', 1))
    }),
    subscribe: vi.fn((_method, _params, onData, options) => {
      listeners.set(options?.executionHost ?? 'desktop', onData)
      return () => listeners.delete(options?.executionHost ?? 'desktop')
    }),
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, listeners, requests, state }
}

const FrameSchema = z.looseObject({
  type: z.string().optional(),
  publicationEpoch: z.string().optional(),
  activeTabId: z.string().nullable().optional(),
  navigationIntent: z.string().optional(),
  tabs: z.array(z.looseObject({ id: z.string(), isActive: z.boolean().optional() })).optional()
})
const tabIds = (frame: unknown) => FrameSchema.parse(frame).tabs?.map((tab) => tab.id)

describe("a server workspace's client, when the desktop publishes its own tabs", () => {
  it('composes the strip from a server stream and a desktop stream into one stream', () => {
    const { client, listeners } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)
    const frames: unknown[] = []

    const stop = view.subscribe('session.tabs.subscribe', PARAMS, (frame) => frames.push(frame))
    listeners.get('desktop')?.(desktopSnapshot('snapshot', 1))
    expect(frames).toEqual([])
    listeners.get(SERVER)?.(serverSnapshot)
    listeners.get('desktop')?.(desktopSnapshot('updated', 2))
    listeners.get(SERVER)?.({ type: 'end' })

    expect(frames.map(tabIdsOrType)).toEqual([['e1', 't1::a'], ['e1', 't1::a'], 'end'])
    // Only the server's own snapshot restarts the phone's stream; a desktop change is an update.
    expect(frames.map((frame) => FrameSchema.parse(frame).type)).toEqual([
      'snapshot',
      'updated',
      'end'
    ])
    stop()
    expect(listeners.size).toBe(0)
  })

  it('runs a call naming a desktop tab on the desktop, and the rest on the server', async () => {
    const { client, requests } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)

    const listed = await view.sendRequest('session.tabs.list', PARAMS)
    expect(listed.ok && tabIds(listed.result)).toEqual(['e1', 't1::a'])
    requests.length = 0
    await view.sendRequest('session.tabs.activate', { ...PARAMS, tabId: 'e1' })
    await view.sendRequest('session.tabs.activate', { ...PARAMS, tabId: 't1' })
    await view.sendRequest('files.read', { ...PARAMS, relativePath: 'a.ts' })

    expect(requests).toEqual([
      { method: 'session.tabs.activate', executionHost: undefined },
      { method: 'session.tabs.activate', executionHost: SERVER },
      { method: 'files.read', executionHost: SERVER }
    ])
  })

  it("ends with the server's stream, and stops the desktop's", () => {
    const { client, listeners } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)
    const frames: unknown[] = []
    view.subscribe('session.tabs.subscribe', PARAMS, (frame) => frames.push(frame))
    const desktopListener = listeners.get('desktop')
    listeners.get(SERVER)?.(serverSnapshot)

    listeners.get(SERVER)?.({ type: 'error', message: 'gone' })
    desktopListener?.(desktopSnapshot('updated', 2))

    expect(listeners.has('desktop')).toBe(false)
    expect(frames.map((frame) => FrameSchema.parse(frame).type)).toEqual(['snapshot', 'error'])
  })

  it("never repeats the server's one-shot follow when the desktop changes", () => {
    const { client, listeners } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)
    const frames: unknown[] = []
    view.subscribe('session.tabs.subscribe', PARAMS, (frame) => frames.push(frame))

    listeners.get(SERVER)?.({ ...serverSnapshot, type: 'updated', navigationIntent: 'follow' })
    listeners.get('desktop')?.(desktopSnapshot('updated', 2))

    expect(frames.map((frame) => FrameSchema.parse(frame).navigationIntent)).toEqual([
      'follow',
      undefined
    ])
  })

  it("shows the phone's tap on a desktop tab over the server's pick, until it taps a server tab", async () => {
    const { client, listeners } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)
    const frames: unknown[] = []
    view.subscribe('session.tabs.subscribe', PARAMS, (frame) => frames.push(frame))
    listeners.get(SERVER)?.(serverSnapshot)
    listeners.get('desktop')?.(desktopSnapshot('snapshot', 1))
    const active = () => FrameSchema.parse(frames.at(-1)).activeTabId
    expect(active()).toBe('t1::a')

    await view.sendRequest('session.tabs.activate', { ...PARAMS, tabId: 'e1' })
    listeners.get('desktop')?.(desktopSnapshot('updated', 2))
    expect(active()).toBe('e1')
    expect(FrameSchema.parse(frames.at(-1)).tabs).toEqual([
      expect.objectContaining({ id: 'e1', isActive: true }),
      expect.objectContaining({ id: 't1::a', isActive: false })
    ])

    await view.sendRequest('session.tabs.activate', { ...PARAMS, tabId: 't1' })
    listeners.get(SERVER)?.({ ...serverSnapshot, type: 'updated' })
    expect(active()).toBe('t1::a')
  })

  it('composes a failed desktop call as its last strip, so list and stream keep one epoch', async () => {
    const { client, listeners, state } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER, true)
    const epoch = (response: RpcResponse) =>
      response.ok ? FrameSchema.parse(response.result).publicationEpoch : null
    const frames: unknown[] = []
    view.subscribe('session.tabs.subscribe', PARAMS, (frame) => frames.push(frame))

    // Before the desktop has answered at all, list and stream agree on an empty desktop side.
    state.desktopFails = true
    listeners.get(SERVER)?.(serverSnapshot)
    const coldList = await view.sendRequest('session.tabs.list', PARAMS)
    expect(epoch(coldList)).toBe('headless:1|desktop:')
    expect(FrameSchema.parse(frames[0]).publicationEpoch).toBe('headless:1|desktop:')

    state.desktopFails = false
    const warm = await view.sendRequest('session.tabs.list', PARAMS)
    state.desktopFails = true
    const failed = await view.sendRequest('session.tabs.list', PARAMS)
    expect(epoch(failed)).toBe(epoch(warm))
    expect(failed.ok && tabIds(failed.result)).toEqual(['e1', 't1::a'])
  })

  it('stays a plain server client when the desktop does not advertise it', async () => {
    expect(composesDesktopTabs([])).toBe(false)
    expect(composesDesktopTabs([MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY])).toBe(true)
    const { client, listeners, requests } = fakeDesktopClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER)

    view.subscribe('session.tabs.subscribe', PARAMS, () => {})
    await view.sendRequest('session.tabs.list', PARAMS)

    expect([...listeners.keys()]).toEqual([SERVER])
    expect(requests).toEqual([{ method: 'session.tabs.list', executionHost: SERVER }])
  })
})

function tabIdsOrType(frame: unknown): string[] | string | undefined {
  return tabIds(frame) ?? FrameSchema.parse(frame).type
}
