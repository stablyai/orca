import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getDefaultUIState } from '../../../../shared/constants'
import { PAIRING_LOCAL_UI_FIELDS } from '../../../../shared/pairing-local-ui-fields'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// Both directions of the pairing boundary for the fields in PAIRING_LOCAL_UI_FIELDS: a client's
// value must never be persisted by the host, and the host's must never be returned to a client.
describe('client UI RPC pairing-local field seams', () => {
  it('drops a paired client manualRepoOrder while forwarding the rest of the payload', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => getDefaultUIState())
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    // A paired web client restamps every repo onto its own runtime:web-* pseudo-host, so its
    // overlay names hosts this profile will never own; persisting it erases the desktop order.
    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        sidebarWidth: 280,
        manualRepoOrder: [
          { hostId: 'runtime:web-11111111-2222-3333-4444-555555555555', repoId: 'repo-a' },
          { hostId: 'runtime:web-11111111-2222-3333-4444-555555555555', repoId: 'repo-b' }
        ]
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateUIState).toHaveBeenCalledWith({ sidebarWidth: 280 })
  })

  // Driven off the census so a field added to PAIRING_LOCAL_UI_FIELDS without wiring a seam
  // fails here rather than shipping. Sample values are what a paired web client actually sends.
  const pairingLocalSamples: Record<(typeof PAIRING_LOCAL_UI_FIELDS)[number], unknown> = {
    automationHostFilter: { kind: 'host', hostKey: 'authority:desktop|selector:self' },
    hideWorkspacesFromOtherDevices: true,
    manualRepoOrder: [
      { hostId: 'runtime:web-11111111-2222-3333-4444-555555555555', repoId: 'repo-a' }
    ],
    workspaceHostOrder: ['runtime:web-11111111-2222-3333-4444-555555555555', 'local'],
    sidebarOpen: false,
    agentsVisibleHostIds: ['runtime:web-11111111-2222-3333-4444-555555555555'],
    agentsFilterRepoIds: ['repo-a'],
    agentsHideWorkspacesFromOtherDevices: true,
    agentsHideAutomationGeneratedWorkspaces: true,
    agentsHideCliCreatedWorkspaces: true,
    agentsShowChildAgents: true,
    agentsCompactMode: false,
    agentsShowSearch: false,
    agentsReadFilter: 'unread',
    agentsGroupBy: 'project',
    activityClearedAtByPaneKey: { 'tab-1:leaf-1': 123 },
    manuallyUnreadTurnsByPaneKey: { 'tab-1:leaf-1': 321 }
  }

  it.each(PAIRING_LOCAL_UI_FIELDS.map((field) => [field] as const))(
    'ui.set never persists the pairing-local field %s',
    async (field) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        updateUIState: vi.fn(() => getDefaultUIState())
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('ui.set', { sidebarWidth: 280, [field]: pairingLocalSamples[field] })
      )

      expect(response).toMatchObject({ ok: true })
      const forwarded = vi.mocked(runtime.updateUIState).mock.calls[0]?.[0] ?? {}
      expect(Object.keys(forwarded)).not.toContain(field)
      expect(forwarded).toMatchObject({ sidebarWidth: 280 })
    }
  )

  // The read path matters as much as the write path: a host that echoes these back overwrites the
  // client's own value, and on a profile poisoned before the write strip the echoed
  // runtime:web-* keys match the very client that minted them.
  it.each(PAIRING_LOCAL_UI_FIELDS.map((field) => [field] as const))(
    'ui.get never returns the pairing-local field %s',
    async (field) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        getUIState: vi.fn(() => ({ ...getDefaultUIState(), [field]: pairingLocalSamples[field] }))
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

      const response = await dispatcher.dispatch(makeRequest('ui.get'))

      const ui = (response as { result: { ui: Record<string, unknown> } }).result.ui
      expect(Object.keys(ui)).not.toContain(field)
      expect(ui).toMatchObject({ sidebarWidth: getDefaultUIState().sidebarWidth })
    }
  )

  it.each(PAIRING_LOCAL_UI_FIELDS.map((field) => [field] as const))(
    'the ui.set and ui.recordFeatureInteraction responses omit the pairing-local field %s',
    async (field) => {
      const stored = { ...getDefaultUIState(), [field]: pairingLocalSamples[field] }
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        updateUIState: vi.fn(() => stored),
        recordFeatureInteraction: vi.fn(() => stored)
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

      const setResponse = await dispatcher.dispatch(makeRequest('ui.set', { sidebarWidth: 280 }))
      const interactionResponse = await dispatcher.dispatch(
        makeRequest('ui.recordFeatureInteraction', 'tasks')
      )

      for (const response of [setResponse, interactionResponse]) {
        const ui = (response as { result: { ui: Record<string, unknown> } }).result.ui
        expect(Object.keys(ui)).not.toContain(field)
      }
    }
  )

  // The host's own phone shows this host's view, so the other-client filter is one shared value.
  describe("the host's own phone mirrors the other-client filter", () => {
    function phoneRuntime(stored: Record<string, unknown>) {
      const ui = { ...getDefaultUIState(), ...stored }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the UI methods read only these runtime members.
      return {
        getRuntimeId: () => 'test-runtime',
        getUIState: vi.fn(() => ui),
        updateUIState: vi.fn(() => ui)
      } as unknown as OrcaRuntimeService
    }
    const ownPhone = { clientKind: 'mobile' } as const
    const delegatedPhone = { clientKind: 'mobile', pairedDeviceParentId: 'other-desktop' } as const
    const UiGetReply = z.object({
      ok: z.literal(true),
      result: z.object({ ui: z.record(z.string(), z.unknown()) })
    })
    function readUi(response: unknown): Record<string, unknown> {
      return UiGetReply.parse(response).result.ui
    }

    it('reads the host value, and false when the host never set it', async () => {
      for (const [stored, expected] of [
        [{ hideWorkspacesFromOtherDevices: true }, true],
        [{}, false]
      ] as const) {
        const dispatcher = new RpcDispatcher({
          runtime: phoneRuntime(stored),
          methods: CLIENT_UI_METHODS
        })
        const response = await dispatcher.dispatch(makeRequest('ui.get'), ownPhone)
        const ui = readUi(response)
        expect(ui.hideWorkspacesFromOtherDevices).toBe(expected)
        expect(Object.keys(ui)).not.toContain('manualRepoOrder')
      }
    })

    it('writes the host value', async () => {
      const runtime = phoneRuntime({})
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
      await dispatcher.dispatch(
        makeRequest('ui.set', { hideWorkspacesFromOtherDevices: true, manualRepoOrder: [] }),
        ownPhone
      )
      expect(runtime.updateUIState).toHaveBeenCalledWith({ hideWorkspacesFromOtherDevices: true })
    })

    it('leaves the host value alone when the phone writes something else', async () => {
      const runtime = phoneRuntime({ hideWorkspacesFromOtherDevices: true })
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
      const response = await dispatcher.dispatch(
        makeRequest('ui.set', { sidebarWidth: 280 }),
        ownPhone
      )
      expect(runtime.updateUIState).toHaveBeenCalledWith({ sidebarWidth: 280 })
      expect(readUi(response).hideWorkspacesFromOtherDevices).toBe(true)
    })

    it('keeps the field from a paired desktop', async () => {
      const runtime = phoneRuntime({ hideWorkspacesFromOtherDevices: true })
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
      const pairedDesktop = { clientKind: 'runtime' } as const
      const read = await dispatcher.dispatch(makeRequest('ui.get'), pairedDesktop)
      await dispatcher.dispatch(
        makeRequest('ui.set', { hideWorkspacesFromOtherDevices: false }),
        pairedDesktop
      )
      expect(Object.keys(readUi(read))).not.toContain('hideWorkspacesFromOtherDevices')
      expect(runtime.updateUIState).toHaveBeenCalledWith({})
    })

    it('keeps the field from a phone relayed for another desktop', async () => {
      const runtime = phoneRuntime({ hideWorkspacesFromOtherDevices: true })
      const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
      const read = await dispatcher.dispatch(makeRequest('ui.get'), delegatedPhone)
      await dispatcher.dispatch(
        makeRequest('ui.set', { hideWorkspacesFromOtherDevices: false }),
        delegatedPhone
      )
      const ui = readUi(read)
      expect(Object.keys(ui)).not.toContain('hideWorkspacesFromOtherDevices')
      expect(runtime.updateUIState).toHaveBeenCalledWith({})
    })
  })
})
