import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handoff = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }))

vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ hostId: 'laptop' }) }))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => handoff }))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'connected' })
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: ['cap'] })
}))
vi.mock('./use-host-worktree-rows', () => ({
  useHostWorktreeRows: () => [{ path: '/repo/marlin', repoId: 'r1', branch: 'marlin' }]
}))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../components/NewWorktreeModalController', () => ({
  NewWorktreeModalController: 'NewWorktreeModalController'
}))

import { NewWorkspacePageScreen } from './NewWorkspacePageScreen'

describe('the Create Workspace page', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  async function render() {
    await act(async () => {
      renderer = create(createElement(NewWorkspacePageScreen))
    })
    return renderer!.root.find((node) => String(node.type) === 'NewWorktreeModalController')
  }

  it("shows the host screen's drawer for the route's desktop, aware of its worktrees", async () => {
    const drawer = await render()

    expect(drawer.props).toMatchObject({
      visible: true,
      hostId: 'laptop',
      hostCapabilities: ['cap'],
      existingWorktreePaths: ['/repo/marlin']
    })
  })

  it('leaves the overlay when the drawer closes', async () => {
    const drawer = await render()

    act(() => drawer.props.onClose())

    expect(handoff.back).toHaveBeenCalledTimes(1)
  })

  it("opens the new workspace's session in the overlay's place", async () => {
    const drawer = await render()

    act(() => drawer.props.onCreated('wt-1', 'Hammerhead', 'No startup terminal', 'ssh:box'))

    expect(handoff.replace).toHaveBeenCalledWith(
      '/h/laptop/session/wt-1?name=Hammerhead&created=1&warning=No+startup+terminal&executionHost=ssh%3Abox'
    )
  })
})
