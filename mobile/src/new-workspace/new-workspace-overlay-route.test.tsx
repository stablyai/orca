import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCatalogEntry, HostProfile } from '../transport/hosts/host-profile'

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }))
const params = vi.hoisted((): { current: Record<string, string> } => ({ current: {} }))
const catalog = vi.hoisted((): { current: HostCatalogEntry[] } => ({ current: [] }))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useRouter: () => router
}))
vi.mock('../transport/hosts/host-store', () => ({
  loadHostCatalog: async () => catalog.current
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('./NewWorkspaceOverlay', () => ({ NewWorkspaceOverlay: 'NewWorkspaceOverlay' }))

import NewWorkspaceOverlayRoute from '../../app/new-workspace'
import { newWorkspaceOverlayHref } from './new-workspace-overlay-route'

function entry(id: string, name: string): HostCatalogEntry {
  const profile: HostProfile = {
    id,
    name,
    endpoint: `ws://${id}.local:6768`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
  const { deviceToken: _deviceToken, ...listed } = profile
  return { ...listed, credentialStatus: 'ready', profile }
}

describe("Home's New Workspace overlay", () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  async function open(hostIds: string[]) {
    params.current = newWorkspaceOverlayHref(hostIds).params
    await act(async () => {
      renderer = create(createElement(NewWorkspaceOverlayRoute))
    })
    const root = renderer!.root
    return {
      overlayFor: () =>
        root.findAll((node) => String(node.type) === 'NewWorkspaceOverlay')[0]?.props.hostId,
      picker: () => root.find((node) => String(node.type) === 'PickerModal')
    }
  }

  it("opens the only offered desktop's drawer without asking", async () => {
    catalog.current = [entry('desk', 'Desk')]
    const overlay = await open(['desk'])

    expect(overlay.overlayFor()).toBe('desk')
  })
})
