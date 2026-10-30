import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { CollapseWriteOrder } from '../../workspace-view-collapse-writes'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { CLIENT_UI_METHODS } from './client-ui'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs'

const ownPhone: RpcDispatchStreamingOptions = { clientKind: 'mobile' }

function makeHost(initialCollapsed: string[] = []) {
  let ui: PersistedUIState = { ...getDefaultUIState(), collapsedGroups: initialCollapsed }
  const fake = {
    getRuntimeId: () => 'test-runtime',
    getUIState: () => ui,
    updateUIState: (updates: Partial<PersistedUIState>) => {
      ui = { ...ui, ...updates }
      return ui
    },
    collapseWriteOrder: new CollapseWriteOrder()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ui.set/ui.setCollapsed read only the members above.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...CLIENT_UI_METHODS, ...SIDEBAR_INPUT_METHODS]
  })
  let requestId = 0
  const call = async (
    method: string,
    params: unknown,
    context: RpcDispatchStreamingOptions = ownPhone
  ) => {
    const request: RpcRequest = { id: `req-${++requestId}`, authToken: 'tok', method, params }
    return dispatcher.dispatch(request, context)
  }
  const collapse = async (
    writer: string,
    seq: number,
    key: string,
    collapsed: boolean,
    context: RpcDispatchStreamingOptions = ownPhone
  ) => call('ui.setCollapsed', { key, collapsed, opId: { writer, seq } }, context)
  return { collapse, call, collapsed: () => [...ui.collapsedGroups].sort() }
}

describe('ui.setCollapsed', () => {
  it('keeps both writers when the desktop and the phone collapse different sections', async () => {
    const host = makeHost()
    await host.collapse('desktop', 1, 'repo:a', true)
    await host.collapse('phone', 1, 'repo:b', true)
    expect(host.collapsed()).toEqual(['repo:a', 'repo:b'])
    await host.collapse('desktop', 2, 'repo:a', false)
    expect(host.collapsed()).toEqual(['repo:b'])
  })

  it('lets the last arrival win when both writers change the same section', async () => {
    const host = makeHost()
    await host.collapse('desktop', 1, 'repo:a', true)
    const response = await host.collapse('phone', 1, 'repo:a', false)
    expect(response).toMatchObject({ ok: true, result: { collapsed: false, applied: true } })
    expect(host.collapsed()).toEqual([])
  })

  it('settles a retry of an op that already landed without undoing a newer writer', async () => {
    const host = makeHost()
    await host.collapse('phone-a', 1, 'repo:a', true)
    await host.collapse('phone-b', 1, 'repo:a', false)
    const retry = await host.collapse('phone-a', 1, 'repo:a', true)
    expect(retry).toMatchObject({ ok: true, result: { collapsed: false, applied: false } })
    expect(host.collapsed()).toEqual([])
  })

  it('drops a writer’s older op that arrives after its newer one', async () => {
    const host = makeHost()
    await host.collapse('phone', 2, 'repo:a', false)
    await host.collapse('phone', 1, 'repo:a', true)
    expect(host.collapsed()).toEqual([])
    await host.collapse('phone', 1, 'repo:b', true)
    expect(host.collapsed()).toEqual(['repo:b'])
  })

  it('keeps per-key ops ordered against an old client’s whole-set write', async () => {
    const host = makeHost()
    await host.collapse('phone-new', 1, 'repo:a', true)
    // Legacy clients still replace the whole set.
    await host.call('ui.set', { collapsedGroups: ['repo:z'] })
    expect(host.collapsed()).toEqual(['repo:z'])
    await host.collapse('phone-new', 1, 'repo:a', true)
    expect(host.collapsed()).toEqual(['repo:z'])
    await host.collapse('phone-new', 2, 'repo:b', true)
    expect(host.collapsed()).toEqual(['repo:b', 'repo:z'])
  })

  it('is applied when the section already has the requested state', async () => {
    const host = makeHost(['repo:a'])
    const response = await host.collapse('phone', 1, 'repo:a', true)
    expect(response).toMatchObject({ ok: true, result: { collapsed: true, applied: true } })
    expect(host.collapsed()).toEqual(['repo:a'])
  })

  it.each([
    ['a local caller', {}],
    ['a paired desktop or web client', { clientKind: 'runtime' as const }]
  ])('accepts %s, as ui.set does', async (_label, context) => {
    const host = makeHost()
    await host.collapse('writer', 1, 'repo:a', true, context)
    expect(host.collapsed()).toEqual(['repo:a'])
  })
})
