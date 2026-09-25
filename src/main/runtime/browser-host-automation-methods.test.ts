import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_METHODS,
  type BrowserClientAutomationMethod
} from '../../shared/browser-client-automation-protocol'
import { BrowserClientHostAttachParams } from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { BrowserHostLeaseAttachInput } from './browser-host-lease-attachment'

const attachInput: BrowserHostLeaseAttachInput = {
  browserHostClientId: 'host-a',
  pairedDeviceId: 'device-a',
  connectionId: 'connection-a',
  hostCapabilities: ['webview', 'automation-v1'],
  pageCommandProtocolVersion: 1,
  pageInventoryProtocolVersion: 1,
  pageInventory: [],
  leaseReconnectProtocolVersion: 1
}

function fixture(supportedAutomationMethods?: BrowserClientAutomationMethod[]) {
  const registry = new BrowserHostLeaseRegistry({ authorityRuntimeId: 'runtime-a' })
  const input = { ...attachInput, supportedAutomationMethods }
  const handle = registry.attach(input)
  const placement = registry.placeClientPage('page-a', 'host-a')
  if (placement.kind !== 'client') {
    throw new Error('Expected client placement')
  }
  const authority = { ...handle.lease, ...placement, browserPageId: 'page-a' }
  const delivery = vi.fn()
  const detachDelivery = registry.attachCommandDelivery(handle.lease, delivery)
  registry.grantExecutionHost(handle.lease, 'ssh:host-a:1')
  const created = registry.issueClientPageCommand(authority, {
    type: 'createPage',
    browserProfileId: 'default',
    executionHostKey: 'ssh:host-a:1'
  })
  registry.settleClientPageCommand(handle.lease, {
    ...created.event,
    result: { status: 'completed' }
  })
  delivery.mockClear()
  const issue = (method: BrowserClientAutomationMethod, params: Record<string, unknown> = {}) =>
    registry.issueClientPageCommand(authority, { type: 'automation', method, params })
  return { registry, input, handle, placement, authority, delivery, issue, detachDelivery }
}

describe('browser host automation method contract', () => {
  it('keeps omitted-set desktop methods and raw exec unchanged', () => {
    const f = fixture()
    expect(f.issue('browser.pdf').event.commandSequence).toBe(2)
    expect(f.issue('browser.exec', { command: 'pdf /tmp/file.pdf' }).event.commandSequence).toBe(3)
    expect(f.delivery).toHaveBeenCalledTimes(2)
    f.handle.release()
  })

  it('denies an explicit empty set before delivery or sequence allocation', () => {
    const f = fixture([])
    for (const method of BROWSER_CLIENT_AUTOMATION_METHODS) {
      expect(() => f.issue(method)).toThrow('browser_client_automation_method_unsupported')
    }
    expect(f.delivery).not.toHaveBeenCalled()
    expect(
      f.registry.issueClientPageCommand(f.authority, {
        type: 'navigate',
        url: 'https://example.test'
      }).event.commandSequence
    ).toBe(2)
    f.handle.release()
  })

  it('allows only the subset and cannot bypass it with exec or forged params', () => {
    const f = fixture(['browser.click', 'browser.snapshot'])
    expect(() => f.issue('browser.pdf', { supportedAutomationMethods: ['browser.pdf'] })).toThrow(
      'browser_client_automation_method_unsupported'
    )
    for (const command of [
      'pdf out.pdf',
      'eval "print()"',
      '--session other click @e1',
      'exec "pdf out.pdf"'
    ]) {
      expect(() => f.issue('browser.exec', { command })).toThrow(
        'browser_client_automation_method_unsupported'
      )
    }
    expect(f.delivery).not.toHaveBeenCalled()
    expect(f.issue('browser.click').event.commandSequence).toBe(2)
    expect(f.delivery).toHaveBeenCalledOnce()
    f.handle.release()
  })

  it.each([
    [undefined, []],
    [[], undefined],
    [['browser.click'], ['browser.snapshot']],
    [['browser.click'], []],
    [[], ['browser.click']]
  ] satisfies [
    BrowserClientAutomationMethod[] | undefined,
    BrowserClientAutomationMethod[] | undefined
  ][])(
    'refuses incompatible reconnect %j -> %j without changing authority or ledger',
    async (original, changed) => {
      const f = fixture(original)
      const pending = f.registry.issueClientPageCommand(f.authority, {
        type: 'navigate',
        url: 'https://example.test'
      })
      const superseded = vi.fn()
      void f.handle.whenConnectionSuperseded.then(superseded)
      expect(() =>
        f.registry.attach({
          ...f.input,
          connectionId: 'connection-b',
          supportedAutomationMethods: changed
        })
      ).toThrow('browser_host_automation_methods_changed')
      expect(f.registry.select('host-a')).toBe(f.handle.lease)
      expect(f.registry.getPlacement('page-a')).toBe(f.placement)
      expect(f.delivery).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(superseded).not.toHaveBeenCalled()
      expect(() =>
        f.registry.settleClientPageCommand(
          { ...f.handle.lease, connectionId: 'connection-b' },
          { ...pending.event, result: { status: 'completed' } }
        )
      ).toThrow('browser_host_lease_stale')
      f.registry.settleClientPageCommand(f.handle.lease, {
        ...pending.event,
        result: { status: 'completed' }
      })
      await expect(pending.result).resolves.toEqual({ status: 'completed' })
      f.handle.release()
    }
  )

  it('normalizes order and duplicates, snapshots caller state, and preserves exact-device reconnect replay', async () => {
    const methods: BrowserClientAutomationMethod[] = [
      'browser.snapshot',
      'browser.click',
      'browser.click'
    ]
    const f = fixture(methods)
    methods.push('browser.pdf')
    expect(f.handle.lease.supportedAutomationMethods).toEqual(['browser.click', 'browser.snapshot'])
    expect(() => f.issue('browser.pdf')).toThrow('browser_client_automation_method_unsupported')
    const pending = f.issue('browser.click')
    f.detachDelivery()
    f.handle.disconnect()
    expect(() =>
      f.registry.attach({
        ...f.input,
        pairedDeviceId: 'device-b',
        supportedAutomationMethods: ['browser.click', 'browser.snapshot']
      })
    ).toThrow('browser_host_identity_conflict')
    expect(() =>
      f.registry.attach({
        ...f.input,
        connectionId: 'connection-b',
        supportedAutomationMethods: []
      })
    ).toThrow('browser_host_automation_methods_changed')
    const resumed = f.registry.attach({
      ...f.input,
      connectionId: 'connection-b',
      supportedAutomationMethods: ['browser.click', 'browser.snapshot']
    })
    expect(resumed.lease.browserHostGeneration).toBe(f.handle.lease.browserHostGeneration)
    expect(f.registry.getPlacement('page-a')).toBe(f.placement)
    const replay = vi.fn()
    f.registry.attachCommandDelivery(resumed.lease, replay)
    expect(replay).toHaveBeenCalledExactlyOnceWith(pending.event)
    expect(() =>
      f.registry.settleClientPageCommand(f.handle.lease, {
        ...pending.event,
        result: { status: 'completed' }
      })
    ).toThrow('browser_host_lease_stale')
    f.registry.settleClientPageCommand(resumed.lease, {
      ...pending.event,
      result: { status: 'completed' }
    })
    await expect(pending.result).resolves.toEqual({ status: 'completed' })
    resumed.release()
  })

  it.each([
    null,
    {},
    'browser.click',
    ['click'],
    ['browser.unknown'],
    ['browser.exec'],
    ['browser.Click'],
    Array(66).fill('browser.click')
  ])('refuses malformed or unrepresentable advertisements %j', (methods) => {
    expect(
      BrowserClientHostAttachParams.safeParse({
        ...attachInput,
        authorityRuntimeId: 'runtime-a',
        supportedAutomationMethods: methods
      }).success
    ).toBe(false)
  })

  it('requires existing automation and command negotiation, without widening mobile admission', () => {
    for (const overrides of [
      { hostCapabilities: ['webview'] },
      { pageCommandProtocolVersion: undefined }
    ]) {
      expect(
        BrowserClientHostAttachParams.safeParse({
          ...attachInput,
          authorityRuntimeId: 'runtime-a',
          supportedAutomationMethods: [],
          ...overrides
        }).success
      ).toBe(false)
      const registry = new BrowserHostLeaseRegistry({ authorityRuntimeId: 'runtime-a' })
      expect(() =>
        registry.attach({ ...attachInput, supportedAutomationMethods: [], ...overrides })
      ).toThrow('browser_host_automation_method_negotiation_required')
      expect(() => registry.select('host-a')).toThrow('browser_host_unavailable')
    }
  })
})
