// Run Expo Router’s actual routing module: canGoBack reads committed state while back queues work, a timing gap mocks would hide.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'

type RoutingModule = {
  canGoBack: () => boolean
  goBack: () => void
  routingQueue: { run: (ref: unknown) => void }
}

type NavigationRef = {
  current: { canGoBack: () => boolean; dispatch: (action: { type: string }) => void }
}

const requireFrom = createRequire(import.meta.url)

function loadRoutingModule(ref: NavigationRef): RoutingModule {
  const root = dirname(requireFrom.resolve('expo-router/package.json'))
  const source = readFileSync(join(root, 'build/global-state/routing.js'), 'utf8')
  const loaded: { exports: Partial<RoutingModule> } = { exports: {} }
  const stubs: Record<string, unknown> = {
    'expo/dom': { IS_DOM: false },
    './router-store': { store: { navigationRef: { isReady: () => true, ...ref } } },
    '../domComponents/emitDomEvent': { emitDomGoBack: () => false }
  }
  new Function('require', 'exports', 'module', source)(
    (id: string) => stubs[id] ?? {},
    loaded.exports,
    loaded
  )
  const { canGoBack, goBack, routingQueue } = loaded.exports
  // Read exports at runtime so Expo upgrades renaming them fail here instead of as unrelated navigationRef errors later.
  if (canGoBack === undefined || goBack === undefined || routingQueue === undefined) {
    throw new Error('the routing module did not define canGoBack, goBack and routingQueue')
  }
  return { canGoBack, goBack, routingQueue }
}

function stackRef(screens: string[]): NavigationRef {
  return {
    current: {
      canGoBack: () => screens.length > 1,
      dispatch: (action) => {
        if (action.type === 'GO_BACK' && screens.length > 1) {
          screens.pop()
        }
      }
    }
  }
}

type MountedRouter = { canGoBack: () => boolean; back: () => void }

const router = vi.hoisted((): { value: MountedRouter | null; pathname: string } => ({
  value: null,
  pathname: '/h/host-a/tasks'
}))

vi.mock('expo-router', () => ({
  useRouter: () => router.value,
  usePathname: () => router.pathname
}))

import { useShellStackPop } from './use-shell-stack-pop'

type Harness = {
  pop: () => BridgeNavigateBackOutcome
  mountSecondShell: () => void
  secondPop: () => BridgeNavigateBackOutcome
  removeHolder: () => void
  screens: string[]
  drain: () => void
  commitRoute: (pathname: string) => void
}

function mount(screens: string[]): Harness {
  const ref = stackRef(screens)
  const routing = loadRoutingModule(ref)
  router.value = { canGoBack: routing.canGoBack, back: () => routing.goBack() }
  const held: {
    pop: (() => BridgeNavigateBackOutcome) | null
    second: (() => BridgeNavigateBackOutcome) | null
  } = {
    pop: null,
    second: null
  }
  function Screen(): null {
    held.pop = useShellStackPop()
    return null
  }
  function SecondShell(): null {
    held.second = useShellStackPop()
    return null
  }
  // Keep one root identity when shells leave; changing root element types would remount hooks and lose the latch owner before it can release.
  function Shells(props: { holder: boolean; second: boolean }): ReactElement {
    return (
      <>
        {props.holder ? <Screen /> : null}
        {props.second ? <SecondShell /> : null}
      </>
    )
  }
  const rendered: { tree: ReturnType<typeof create> | null } = { tree: null }
  act(() => {
    rendered.tree = create(<Shells holder second={false} />)
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('nothing rendered')
  }
  mounted.push(tree)
  function callHeld(which: 'pop' | 'second'): BridgeNavigateBackOutcome {
    const pop = held[which]
    if (pop === null) {
      throw new Error(`no ${which} shell is mounted`)
    }
    return pop()
  }
  if (held.pop === null) {
    throw new Error('nothing mounted')
  }
  return {
    pop: () => callHeld('pop'),
    secondPop: () => callHeld('second'),
    mountSecondShell: () => {
      act(() => {
        tree.update(<Shells holder second />)
      })
      if (held.second === null) {
        throw new Error('the second shell did not mount')
      }
    },
    removeHolder: () => {
      act(() => {
        tree.update(<Shells holder={false} second />)
      })
    },
    screens,
    drain: () => {
      routing.routingQueue.run(ref)
    },
    commitRoute: (pathname) => {
      router.pathname = pathname
      act(() => {
        tree.update(<Screen />)
      })
    }
  }
}

// Unmount between cases because pending pops are module-scoped and owned until route commit or unmount.
const mounted: ReturnType<typeof create>[] = []

beforeEach(() => {
  router.pathname = '/h/host-a/tasks'
})

function unmountAll(): void {
  act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
}

afterEach(() => {
  unmountAll()
  // Verify release with a new screen after teardown so the final case cannot hide a leaked stack latch.
  const probe = mount(['home', 'host'])
  expect(probe.pop(), 'a case left the stack latch set').toBe('popped')
  unmountAll()
})

describe('a page that asks to go back twice in one batch', () => {
  it('pops once, because the second frame reads a stack the first has not left yet', () => {
    const harness = mount(['home', 'host', 'tasks'])
    expect(harness.pop()).toBe('popped')
    expect(harness.pop()).toBe('pop-pending')
    harness.drain()
    expect(harness.screens).toEqual(['home', 'host'])
  })

  it('takes the next pop once the route the first one produced has committed', () => {
    const harness = mount(['home', 'host', 'tasks'])
    expect(harness.pop()).toBe('popped')
    harness.drain()
    harness.commitRoute('/h/host-a')
    expect(harness.pop()).toBe('popped')
    harness.drain()
    expect(harness.screens).toEqual(['home'])
  })

  it('refuses with its own reason when the stack has nothing to pop', () => {
    const harness = mount(['home'])
    expect(harness.pop()).toBe('nothing-to-pop')
    harness.drain()
    expect(harness.screens).toEqual(['home'])
  })
})

// Use one latch per stack: multiple mounted shell screens can otherwise each queue a pop in the same native batch.
describe('two shells over one stack', () => {
  it('share the latch, so the second one cannot pop what the first already queued', () => {
    const harness = mount(['home', 'host', 'tasks'])
    harness.mountSecondShell()
    expect(harness.pop()).toBe('popped')
    expect(harness.secondPop()).toBe('pop-pending')
    harness.drain()
    expect(harness.screens).toEqual(['home', 'host'])
  })

  it('release the latch when the screen holding it goes away, so a stick cannot outlive it', () => {
    const harness = mount(['home', 'host', 'tasks'])
    harness.mountSecondShell()
    expect(harness.pop()).toBe('popped')
    // A missing navigation ref discards the pop without a commit; only owner unmount releases that latch.
    harness.removeHolder()
    expect(harness.secondPop()).toBe('popped')
  })
})
