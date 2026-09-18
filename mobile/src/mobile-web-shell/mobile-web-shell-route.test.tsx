import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = { storage: Map<string, string>; mounted: string[] }

const dependencies = vi.hoisted((): RouteDependencies => ({ storage: new Map(), mounted: [] }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => ({ hostId: 'host-1' })
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: { hostId: string }) => {
    dependencies.mounted.push(props.hostId)
    return null
  }
}))

import MobileWebShellRoute from '../../app/h/[hostId]/web'

/** Host elements are matched by name, not by `findAllByType`: React's `ElementType` does not admit
 *  an arbitrary React Native host name, so the typed form is a predicate. */
function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

async function renderRoute(): Promise<ReactTestRenderer> {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebShellRoute))
  })
  if (rendered.tree === null) {
    throw new Error('route did not render')
  }
  return rendered.tree
}

/** `__DEV__` is a React Native global, absent outside that runtime; assigned rather than cast so
 *  the test says which build kind it is running as without asserting a type on `globalThis`. */
function setDevelopmentBuild(isDevelopmentBuild: boolean | undefined): void {
  if (isDevelopmentBuild === undefined) {
    Reflect.deleteProperty(globalThis, '__DEV__')
    return
  }
  Object.assign(globalThis, { __DEV__: isDevelopmentBuild })
}

describe('the hybrid shell route', () => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.mounted.length = 0
    setDevelopmentBuild(true)
  })

  it('redirects to the host screen with the flag unset, and mounts nothing', async () => {
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect').map((node) => node.props.href)).toEqual(['/h/host-1'])
    expect(dependencies.mounted).toEqual([])
  })

  it('redirects with the flag explicitly off', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'false')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toHaveLength(1)
    expect(dependencies.mounted).toEqual([])
  })

  it('mounts the shell screen for this host with the flag on', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toEqual([])
    expect(dependencies.mounted).toEqual(['host-1'])
  })

  it('redirects a store build whose container kept a flag a development build set', async () => {
    setDevelopmentBuild(undefined)
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const tree = await renderRoute()
    expect(byName(tree, 'Redirect')).toHaveLength(1)
    expect(dependencies.mounted).toEqual([])
  })

  it('neither redirects nor mounts until the flag has been read', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    // No `await` inside act: the effect's promise is deliberately left unsettled.
    act(() => {
      rendered.tree = create(createElement(MobileWebShellRoute))
    })
    const tree = rendered.tree
    expect(tree === null ? [] : byName(tree, 'Redirect')).toEqual([])
    expect(dependencies.mounted).toEqual([])
    await act(async () => {})
  })
})
