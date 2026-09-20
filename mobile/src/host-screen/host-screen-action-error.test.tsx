import { existsSync } from 'node:fs'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

type Doubles = { removeRejects: boolean; alerts: unknown[][] }

const doubles = vi.hoisted((): Doubles => ({ removeRejects: true, alerts: [] }))

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
vi.mock('./host-screen-header', () => ({ HostScreenHeader: () => null }))
vi.mock('./host-workspace-list', () => ({ HostWorkspaceList: () => null }))
vi.mock('./host-screen-overlays', () => ({ HostScreenOverlays: () => null }))
vi.mock('../transport/host-removal-lifecycle', () => ({
  removeHostAndCloseClient: () =>
    doubles.removeRejects ? Promise.reject(new Error('still paired')) : Promise.resolve()
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))

import { useRouter } from 'expo-router'
import { HostScreenView } from './host-screen-view'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import type { HostScreenState } from './use-host-screen-state'

function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

/**
 * Only the two fields the view reads before it decides whether to render the screen at all.
 *
 * Everything below the early return is a child this file mocks away, so no other member of the
 * controller is reachable from what these cases exercise.
 */
function controllerWith(fields: { error: string; actionError: string }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `HostScreenView` reads `state.error` and then hands the controller to three mocked children, so these two fields are the whole reachable surface.
  return { state: fields } as unknown as Parameters<typeof HostScreenView>[0]['controller']
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

describe('a removal that failed', () => {
  it('keeps the list, the header and the overlays on screen', () => {
    // The confirm this failure re-opens lives in the overlays, so a screen that early-returned
    // would be asking the user to confirm against a view that is not rendering it.
    const tree = render({ error: '', actionError: 'Could not remove host. Please try again.' })
    expect(byName(tree, 'SafeAreaView')).toHaveLength(1)
    expect(byName(tree, 'Text')).toEqual([])
  })

  it('still lets the identity error take the whole screen, which is what it is for', () => {
    const tree = render({ error: 'Host not found', actionError: '' })
    expect(byName(tree, 'SafeAreaView')).toEqual([])
    expect(byName(tree, 'Text')[0]?.props.children).toBe('Host not found')
  })

  it('writes the transient surface and never the identity one, and raises no alert', async () => {
    doubles.alerts.length = 0
    const writes: { action: string[]; identity: string[]; confirm: boolean[] } = {
      action: [],
      identity: [],
      confirm: []
    }
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
    expect(writes.action).toEqual(['Could not remove host. Please try again.'])
    expect(writes.identity).toEqual([])
    expect(writes.confirm).toEqual([true])
    // `Alert.alert` is a silent no-op in React Native Web, which is why this path stopped using it.
    expect(doubles.alerts).toEqual([])
  })

  it('renders from the same module on both platforms, so one check covers each', () => {
    // No `.web.tsx` sibling for either file: the page and the app run this exact tree, which is
    // what makes the two render assertions above true of both.
    for (const module of ['host-screen-view', 'host-workspace-list']) {
      expect(existsSync(new URL(`./${module}.web.tsx`, import.meta.url)), module).toBe(false)
    }
  })
})
