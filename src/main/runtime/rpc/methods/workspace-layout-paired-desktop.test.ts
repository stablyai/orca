// Layout-owner servers offer intents to desktops only, while retaining every legacy session.tabs mutation.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../../../shared/workspace-layout/layout-intents-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcCallerScope } from '../rpc-caller-scope'

const PAIRED_DESKTOP: RpcCallerScope = { kind: 'runtime-paired', grants: [] }
const PHONE: RpcCallerScope = { kind: 'mobile' }
const LAYOUT_METHODS = [
  'layout.subscribe',
  'layout.unsubscribe',
  'layout.apply',
  'layout.reopenHeldPanes',
  'layout.reportView'
] as const

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

// Loaded once as a layout-owner build; window-owned registration is covered in workspace-layout-apply.test.ts.
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'

const Frame = z.object({ type: z.string(), subscriptionId: z.string().optional() })
const StreamReply = z.object({ ok: z.literal(true), result: Frame })

function request(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'unused', method, params }
}

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

// The first import transforms the whole runtime graph (22-30+ s on a loaded CI shard); later
// switchedBuild calls reset modules but reuse those transforms, so pay it once outside any test.
beforeAll(async () => {
  await switchedBuild(true)
}, 120_000)

afterEach(() => {
  layoutOwner.isMain = true
})

describe('the layout intents capability', () => {
  it('is advertised only by a layout-owner build', () => {
    expect(new OrcaRuntimeService().getStatus().capabilities).toEqual(
      expect.arrayContaining([
        LAYOUT_INTENTS_RUNTIME_CAPABILITY,
        LAYOUT_REOPEN_HELD_PANES_CAPABILITY
      ])
    )
    layoutOwner.isMain = false
    const offCapabilities = new OrcaRuntimeService().getStatus().capabilities
    expect(offCapabilities).not.toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
    expect(offCapabilities).not.toContain(LAYOUT_REOPEN_HELD_PANES_CAPABILITY)
  })

  it('comes with the layout methods registered', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of LAYOUT_METHODS) {
      expect(registered.has(method), method).toBe(true)
    }
  })
})

describe('layout methods on a layout-owner server', () => {
  it.each([
    ['layout.subscribe', 'method_not_supported'],
    ['layout.unsubscribe', 'invalid_argument'],
    ['layout.apply', 'invalid_argument'],
    ['layout.reopenHeldPanes', 'invalid_argument'],
    ['layout.reportView', 'invalid_argument']
  ] as const)('admits a paired desktop and refuses a phone: %s', async (method, nextCheck) => {
    const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
    const asDesktop = await dispatcher.dispatch(request(method, { bad: 1 }), {
      callerScope: PAIRED_DESKTOP
    })
    const asPhone = await dispatcher.dispatch(request(method, { bad: 1 }), { callerScope: PHONE })
    expect(errorCode(asDesktop)).toBe(nextCheck)
    expect(errorCode(asPhone)).toBe('forbidden')
  })

  it('streams a snapshot to a paired desktop', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime })
    const frames: z.infer<typeof Frame>[] = []
    const done = dispatcher.dispatchStreaming(
      request('layout.subscribe'),
      (raw) => frames.push(StreamReply.parse(JSON.parse(raw)).result),
      { callerScope: PAIRED_DESKTOP, connectionId: 'desktop-1', clientKind: 'runtime' }
    )
    await vi.waitFor(() => expect(frames[0]?.type).toBe('snapshot'))

    const unsubscribed = await dispatcher.dispatch(
      request('layout.unsubscribe', { subscriptionId: frames[0]?.subscriptionId }),
      { callerScope: PAIRED_DESKTOP, connectionId: 'desktop-1', clientKind: 'runtime' }
    )
    expect(unsubscribed.ok).toBe(true)
    await done
    expect(frames.at(-1)?.type).toBe('end')
  })
})

describe('layout.reportView', () => {
  const DESKTOP = {
    callerScope: PAIRED_DESKTOP,
    connectionId: 'desktop-1',
    clientKind: 'runtime' as const
  }

  it("records the desktop's groups under its connection", async () => {
    const runtime = new OrcaRuntimeService()
    const reported = vi.spyOn(runtime, 'reportClientView')
    const dispatcher = new RpcDispatcher({ runtime })
    const reply = await dispatcher.dispatch(
      request('layout.reportView', { activeGroupByWorkspace: { 'wt-1': 'g2', 'wt-2': null } }),
      DESKTOP
    )
    expect(reply.ok).toBe(true)
    expect(reported).toHaveBeenCalledWith('desktop-1', { 'wt-1': 'g2', 'wt-2': null }, false)
  })

  it('passes a refresh on as one', async () => {
    const runtime = new OrcaRuntimeService()
    const reported = vi.spyOn(runtime, 'reportClientView')
    const reply = await new RpcDispatcher({ runtime }).dispatch(
      request('layout.reportView', { activeGroupByWorkspace: { 'wt-1': 'g2' }, refresh: true }),
      DESKTOP
    )
    expect(reply.ok).toBe(true)
    expect(reported).toHaveBeenCalledWith('desktop-1', { 'wt-1': 'g2' }, true)
  })

  it('refuses a caller with no connection to tie the report to', async () => {
    const runtime = new OrcaRuntimeService()
    const reported = vi.spyOn(runtime, 'reportClientView')
    const reply = await new RpcDispatcher({ runtime }).dispatch(
      request('layout.reportView', { activeGroupByWorkspace: { 'wt-1': 'g2' } }),
      { callerScope: PAIRED_DESKTOP, clientKind: 'runtime' }
    )
    expect(reply.ok).toBe(false)
    expect(reported).not.toHaveBeenCalled()
  })

  it.each([
    [{}],
    [{ activeGroupByWorkspace: { 'wt-1': 7 } }],
    [{ activeGroupByWorkspace: { 'wt-1': '' } }],
    [{ activeGroupByWorkspace: ['g1'] }],
    [{ activeGroupByWorkspace: {}, refresh: false }]
  ])('refuses params it cannot read: %j', async (params) => {
    const runtime = new OrcaRuntimeService()
    const reported = vi.spyOn(runtime, 'reportClientView')
    const reply = await new RpcDispatcher({ runtime }).dispatch(
      request('layout.reportView', params),
      DESKTOP
    )
    expect(errorCode(reply)).toBe('invalid_argument')
    expect(reported).not.toHaveBeenCalled()
  })
})

describe('an older desktop on a layout-owner server', () => {
  const WT = 'wt-1'
  const SELECTOR = `id:${WT}`
  // Older desktops never send intents; capability belongs to the server.
  const OLDER_DESKTOP = {
    callerScope: PAIRED_DESKTOP,
    clientKind: 'runtime' as const,
    connectionId: 'older-desktop',
    pairedDeviceId: 'older-desktop',
    clientCapabilities: remoteRuntimeClientCapabilities()
  }

  function terminalTab(parentTabId: string, isActive: boolean) {
    return {
      type: 'terminal' as const,
      id: `${parentTabId}::leaf-1`,
      parentTabId,
      leafId: 'leaf-1',
      title: 'Terminal',
      status: 'ready' as const,
      terminal: `pty-${parentTabId}`,
      isActive
    }
  }

  function published(): RuntimeMobileSessionTabsSnapshot {
    return {
      worktree: WT,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-a',
      activeTabId: 'tab-a::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'group-a', activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b', 'tab-c'] }],
      tabs: [terminalTab('tab-a', true), terminalTab('tab-b', false), terminalTab('tab-c', false)]
    }
  }

  /** A windowless (serve) host: no notifier, its tabs already published. */
  async function headlessServer() {
    class HeadlessServer extends OrcaRuntimeService {
      seed(): void {
        this.storeMobileSessionSnapshot(WT, published())
      }
      current(): RuntimeMobileSessionTabsSnapshot | undefined {
        return this.mobileSessionTabsByWorktree.get(WT)
      }
    }
    const runtime = new HeadlessServer()
    runtime.seed()
    const dispatcher = new RpcDispatcher({ runtime })
    const send = (method: string, params: unknown) =>
      dispatcher.dispatch(request(method, params), OLDER_DESKTOP)
    return { runtime, send, current: () => runtime.current() }
  }

  const MUTATIONS = [
    ['session.tabs.activate', 'activateMobileSessionTab', { tabId: 'tab-b' }],
    [
      'session.tabs.move',
      'moveMobileSessionTab',
      {
        kind: 'reorder',
        tabId: 'tab-c',
        targetGroupId: 'group-a',
        tabOrder: ['tab-c', 'tab-a', 'tab-b']
      }
    ],
    [
      'session.tabs.updatePaneLayout',
      'updateMobileSessionPaneLayout',
      { tabId: 'tab-a', root: { type: 'leaf', leafId: 'leaf-1' } }
    ],
    ['session.tabs.setTabProps', 'setMobileSessionTabProps', { tabId: 'tab-b', color: 'red' }],
    ['session.tabs.close', 'closeMobileSessionTab', { tabId: 'tab-c', reason: 'user' }],
    [
      'session.tabs.closeLifecycle',
      'closeMobileSessionTab',
      { tabId: 'tab-c', reason: 'pty-exit', publicationEpoch: 'epoch-1', terminal: 'pty-tab-c' }
    ],
    ['session.tabs.createTerminal', 'createMobileSessionTerminal', {}]
  ] as const

  it.each(MUTATIONS)('still serves %s', async (method, runtimeMethod, params) => {
    const { runtime, send } = await headlessServer()
    // The method's own refusal proves registration, scope and projection admitted the request.
    const served = vi.spyOn(runtime, runtimeMethod).mockRejectedValue(new Error('reached'))
    const response = await send(method, { worktree: SELECTOR, ...params })
    expect(response.ok ? null : response.error.message).toBe('reached')
    expect(served).toHaveBeenCalledTimes(1)
  })

  it('reorders tabs on the windowless path', async () => {
    const { send, current } = await headlessServer()
    const response = await send('session.tabs.move', {
      worktree: SELECTOR,
      kind: 'reorder',
      tabId: 'tab-c',
      targetGroupId: 'group-a',
      tabOrder: ['tab-c', 'tab-a', 'tab-b']
    })
    expect(errorCode(response)).toBeNull()
    expect(current()?.tabGroups?.[0]?.tabOrder).toEqual(['tab-c', 'tab-a', 'tab-b'])
  })

  it('names a tab on the windowless path', async () => {
    const { send, current } = await headlessServer()
    const response = await send('session.tabs.setTabProps', {
      worktree: SELECTOR,
      tabId: 'tab-b',
      customTitle: 'Build'
    })
    expect(errorCode(response)).toBeNull()
    const named = current()?.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-b'
    )
    expect(named?.title).toBe('Build')
  })
})
