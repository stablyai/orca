/**
 * The pop the page asks for, driven through expo-router's own routing module.
 *
 * `canGoBack()` and `back()` disagree about time: the first reads the committed navigation state,
 * the second only adds `GO_BACK` to a queue that a later effect drains. A mock of `canGoBack` hides
 * exactly that, so this evaluates `expo-router/build/global-state/routing.js` verbatim with only
 * its externals stubbed, and the stack below is the one React Navigation would have dispatched to.
 */
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

/** The shipped bytes, not a re-implementation: only what the module reaches outward for is stubbed. */
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
  // Read rather than asserted, and what it catches is an expo-router upgrade that renames or drops
  // one of these three. A missing stub does not reach here: the module assigns its exports whatever
  // its imports resolved to, so that failure is a `TypeError` about `navigationRef` at call time.
  if (canGoBack === undefined || goBack === undefined || routingQueue === undefined) {
    throw new Error('the routing module did not define canGoBack, goBack and routingQueue')
  }
  return { canGoBack, goBack, routingQueue }
}

/** A stack the real `GO_BACK` action pops, so a pop that was queued twice is visible as two. */
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

// `useRouter` answers with the real routing module's own members, wired the way
// `expo-router/build/imperative-api.js` wires them: `back: () => goBack()`, `canGoBack` direct.
vi.mock('expo-router', () => ({
  useRouter: () => router.value,
  usePathname: () => router.pathname
}))

import { useShellStackPop } from './use-shell-stack-pop'

type Harness = {
  pop: () => BridgeNavigateBackOutcome
  /** A second `MobileWebShellScreen` over the same native stack, which `/h/a/web` makes reachable. */
  mountSecondShell: () => void
  /** The second shell's own pop, through whichever instance is mounted when it is called. */
  secondPop: () => BridgeNavigateBackOutcome
  /** Unmounts the screen that took the latch and leaves the second one mounted. */
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
  // One root component for the life of the tree, with a slot per shell. Swapping the root element
  // instead — a fragment for two shells, the shell itself for one — remounts everything under it,
  // which hands the test a callback belonging to an unmounted hook: it can still take the latch,
  // and the instance that took it is already gone, so nothing is left to release it.
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
  /** Re-read on every call, so a pop always goes through the instance that is mounted now. */
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

/** Unmounted between cases, because the latch outlives a tree that is only dropped: one stack, one
 *  pending pop, and a screen that never went away is a screen still holding it. */
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
  // The latch is one per stack, so a case that left it set shows up in the next case — and in the
  // last case of a file, never. Read it here, through the only thing that can observe it: a screen
  // mounted after every other one is gone must still be able to pop.
  const probe = mount(['home', 'host'])
  expect(probe.pop(), 'a case left the stack latch set').toBe('popped')
  unmountAll()
})

describe('a page that asks to go back twice in one batch', () => {
  it('pops once, because the second frame reads a stack the first has not left yet', () => {
    const harness = mount(['home', 'host', 'tasks'])
    // One native batch: both frames are dispatched before React commits anything.
    expect(harness.pop()).toBe('popped')
    expect(harness.pop()).toBe('pop-pending')
    harness.drain()
    // Without the latch both `GO_BACK`s are queued and this is `['home']` — the host screen the
    // page was opened over is gone.
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

/**
 * One native stack, so one pending pop.
 *
 * `MobileWebShellScreen` mounts at both `app/h/[hostId]/index.tsx` and `app/h/[hostId]/web.tsx`,
 * and `/h/a/web` is deep-linkable over `/h/a`, so two shells can be mounted over one stack. A latch
 * per screen leaves each of them holding its own and two frames still unwind two screens.
 */
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
    // The pop is discarded rather than committed, which is what `routingQueue.run` does when the
    // container ref is gone: no route commits, so nothing else would ever clear this.
    harness.removeHolder()
    expect(harness.secondPop()).toBe('popped')
  })
})
