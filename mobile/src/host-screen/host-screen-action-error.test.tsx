import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

type Doubles = { removalRejection: unknown; alerts: unknown[][] }

const doubles = vi.hoisted((): Doubles => ({
  removalRejection: new Error('still paired'),
  alerts: []
}))

vi.mock('react-native', () => ({
  Alert: {
    alert: (...args: unknown[]) => {
      doubles.alerts.push(args)
    }
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('./host-screen-header', () => ({
  HostScreenHeader: 'HostScreenHeader',
  HostConnectionStatus: 'HostConnectionStatus'
}))
vi.mock('./host-workspace-list', () => ({ HostWorkspaceList: 'HostWorkspaceList' }))
vi.mock('./host-bottom-bar', () => ({ HostBottomBar: 'HostBottomBar' }))
vi.mock('../components/nav-bar/PageTitle', () => ({
  PageTitle: 'PageTitle',
  useCollapsingTitle: () => ({})
}))
vi.mock('./host-screen-overlays', () => ({ HostScreenOverlays: 'HostScreenOverlays' }))
vi.mock('../transport/host-removal-lifecycle', () => ({
  removeHostAndCloseClient: () => Promise.reject(doubles.removalRejection)
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))

import { useRouter } from 'expo-router'
import { PageHostRemovalUnavailableError } from '../transport/page-host-removal-refusal'
import { HostScreenView } from './host-screen-view'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import type { HostScreenState } from './use-host-screen-state'

function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

function controllerWith(fields: { error: string; actionError: string }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `HostScreenView` reads `state.error`, `hostDisplay` and the list ref, then hands the controller to four mocked children, so these fields are the whole reachable surface.
  return {
    state: fields,
    hostDisplay: { title: 'Host' },
    activeWorktreeScroll: { sectionListRef: { current: null } }
  } as unknown as Parameters<typeof HostScreenView>[0]['controller']
}

function render(fields: { error: string; actionError: string }): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(HostScreenView, { controller: controllerWith(fields) }))
  })
  if (rendered.tree === null) {
    throw new Error('the view did not render')
  }
  return rendered.tree
}

type RemovalWrites = { action: string[]; identity: string[]; confirm: boolean[] }

async function runRemoval(rejection: unknown): Promise<RemovalWrites> {
  doubles.alerts.length = 0
  doubles.removalRejection = rejection
  const writes: RemovalWrites = { action: [], identity: [], confirm: [] }
  const held: { remove: (() => Promise<void>) | null } = { remove: null }
  const partialState = {
    setActionError: (value: string) => writes.action.push(value),
    setError: (value: string) => writes.identity.push(value),
    setConfirmRemoveHost: (value: boolean) => writes.confirm.push(value)
  }
  function Probe(): null {
    const actions = useHostWorktreeActions({
      client: null,
      connState: 'connected',
      embedded: false,
      fetchWorktrees: () => Promise.resolve(),
      forgetHostClient: () => {},
      hostCapabilities: [],
      hostId: 'host-a',
      pathname: '/h/host-a',
      router: useRouter(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal path reads exactly these three setters and `hostId`; no other member of the state is reachable from it.
      state: partialState as unknown as HostScreenState
    })
    held.remove = actions.handleRemoveHost
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    await held.remove?.()
  })
  return writes
}

describe('a removal that failed', () => {
  it('keeps the list, the header and the overlays on screen', () => {
    // The reopened confirm lives in overlays; early-returning the screen would hide the action needed to recover.
    const tree = render({ error: '', actionError: 'Could not remove host. Please try again.' })
    expect(byName(tree, 'SafeAreaView')).toHaveLength(1)
    expect(byName(tree, 'HostScreenHeader')).toHaveLength(1)
    expect(byName(tree, 'HostWorkspaceList')).toHaveLength(1)
    expect(byName(tree, 'HostBottomBar')).toHaveLength(1)
    expect(byName(tree, 'HostScreenOverlays')).toHaveLength(1)
    expect(byName(tree, 'Text')).toEqual([])
  })

  it('still lets the identity error take the whole screen, which is what it is for', () => {
    const tree = render({ error: 'Host not found', actionError: '' })
    expect(byName(tree, 'SafeAreaView')).toEqual([])
    expect(byName(tree, 'Text')[0]?.props.children).toBe('Host not found')
  })

  it('writes the transient surface and never the identity one, and raises no alert', async () => {
    const writes = await runRemoval(new Error('still paired'))
    expect(writes.action).toEqual(['Could not remove host. Please try again.'])
    expect(writes.identity).toEqual([])
    expect(writes.confirm).toEqual([true])
    // `Alert.alert` is a silent no-op in React Native Web, which is why this path stopped using it.
    expect(doubles.alerts).toEqual([])
  })

  it('says where removal happens when the page refuses, and re-offers nothing', async () => {
    // Page removal is unsupported, so its refusal must not reopen an unusable confirm.
    const writes = await runRemoval(new PageHostRemovalUnavailableError())
    expect(writes.action).toEqual(['Remove this host from the host list in the Orca app.'])
    expect(writes.confirm).toEqual([])
    expect(writes.identity).toEqual([])
  })
})
