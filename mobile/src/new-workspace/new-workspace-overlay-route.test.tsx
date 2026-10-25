import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCatalogEntry, HostProfile } from '../transport/types'

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }))
const params = vi.hoisted((): { current: Record<string, string> } => ({ current: {} }))
const catalog = vi.hoisted((): { current: HostCatalogEntry[] } => ({ current: [] }))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useRouter: () => router
}))
vi.mock('../transport/host-store', () => ({
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

  it('asks which desktop and starts its drawer while the picker slides away', async () => {
    catalog.current = [entry('laptop', 'Laptop'), entry('desk', 'Desk')]
    const overlay = await open(['desk', 'laptop'])

    expect(overlay.overlayFor()).toBeUndefined()
    expect(overlay.picker().props).toMatchObject({ visible: true, title: 'Create Workspace On' })
    expect(overlay.picker().props.options.map((option: { value: string }) => option.value)).toEqual(
      ['desk', 'laptop']
    )

    // PickerModal closes itself after a select.
    act(() => {
      overlay.picker().props.onSelect('laptop')
      overlay.picker().props.onClose()
    })
    expect(overlay.picker().props.visible).toBe(false)
    expect(overlay.overlayFor()).toBe('laptop')

    act(() => overlay.picker().props.onAfterClose())
    expect(overlay.overlayFor()).toBe('laptop')
    expect(router.back).not.toHaveBeenCalled()
  })

  it('leaves for Home when the picker is dismissed without a pick', async () => {
    catalog.current = [entry('laptop', 'Laptop'), entry('desk', 'Desk')]
    const overlay = await open(['desk', 'laptop'])

    act(() => overlay.picker().props.onClose())
    act(() => overlay.picker().props.onAfterClose())

    expect(router.back).toHaveBeenCalledTimes(1)
    expect(overlay.overlayFor()).toBeUndefined()
  })
})
