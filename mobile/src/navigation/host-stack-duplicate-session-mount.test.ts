import { describe, expect, it, vi } from 'vitest'
import {
  convergeOnMountedHostStackRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState,
  type HostStackRouteTarget
} from './host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'

// ---------------------------------------------------------------------------
// A model of the navigators this owner actually dispatches into, transcribed
// from @react-navigation/routers@7.5.3 StackRouter (PUSH / REPLACE / POP_TO)
// and expo-router@55's getNavigateAction/findDivergentState. The production
// owner drives it, and every assertion below reads the resulting MOUNTED ROUTE
// LIST — never the calls the owner made. A guard that merely declines to call
// `push` cannot satisfy these; only a state with one session screen can.
// ---------------------------------------------------------------------------

type MutableRoute = {
  key: string
  name: string
  params?: Record<string, unknown>
  state?: MutableState
}
type MutableState = { key: string; index: number; routes: MutableRoute[] }

let keySeq = 0
const freshKey = (name: string) => `${name}#${++keySeq}`

type StackAction =
  | { type: 'PUSH'; target: string; payload: { name: string; params?: Record<string, unknown> } }
  | {
      type: 'REPLACE'
      target: string
      source?: string
      payload: { name: string; params?: Record<string, unknown> }
    }
  | { type: 'POP_TO'; target: string; source?: string; payload: { name: string; merge?: boolean } }

/** StackRouter.getStateForAction, for the branches reachable with no `getId`. */
function applyToNavigator(state: MutableState, action: StackAction): boolean {
  if (state.key === action.target) {
    if (action.type === 'PUSH') {
      state.routes.push({
        key: freshKey(action.payload.name),
        name: action.payload.name,
        params: action.payload.params
      })
      state.index = state.routes.length - 1
      return true
    }
    if (action.type === 'REPLACE') {
      const currentIndex = action.source
        ? state.routes.findIndex((route) => route.key === action.source)
        : state.index
      if (currentIndex === -1) {
        return true
      }
      // REPLACE always mints a fresh key: it never reuses an existing route, which
      // is exactly why it can mount a second copy of an already-mounted screen.
      state.routes[currentIndex] = {
        key: freshKey(action.payload.name),
        name: action.payload.name,
        params: action.payload.params
      }
      return true
    }
    const currentIndex = action.source
      ? state.routes.findLastIndex((route) => route.key === action.source)
      : state.index
    if (currentIndex === -1) {
      return true
    }
    let index = -1
    if (state.routes[currentIndex].name === action.payload.name) {
      index = currentIndex
    } else {
      for (let i = currentIndex; i >= 0; i--) {
        if (state.routes[i].name === action.payload.name) {
          index = i
          break
        }
      }
    }
    if (index === -1) {
      return true
    }
    // `merge` with no params leaves the route object — and so its mounted screen —
    // untouched; the routes above it are dropped.
    state.routes = state.routes.slice(0, index + 1)
    state.index = index
    return true
  }
  for (const route of state.routes) {
    if (route.state && applyToNavigator(route.state, action)) {
      return true
    }
  }
  return false
}

/** findDivergentState: descend the FOCUSED chain until names or a dynamic segment differ. */
function divergentNavigator(state: MutableState, hostId: string): MutableState {
  const focused = state.routes[state.index]
  if (focused?.name !== 'h' || !focused.state) {
    return state
  }
  const inner = focused.state
  const innerFocused = inner.routes[inner.index]
  if (innerFocused?.name !== '[hostId]/index' || innerFocused.params?.hostId !== hostId) {
    return inner
  }
  return inner
}

/** expo-router `router.push('/h/<hostId>')`. */
function pushHostRoute(root: MutableState, hostId: string): void {
  const navigator = divergentNavigator(root, hostId)
  if (navigator === root) {
    const nestedKey = freshKey('h-stack')
    root.routes.push({
      key: freshKey('h'),
      name: 'h',
      state: {
        key: nestedKey,
        index: 0,
        routes: [{ key: freshKey('[hostId]/index'), name: '[hostId]/index', params: { hostId } }]
      }
    })
    root.index = root.routes.length - 1
    return
  }
  applyToNavigator(root, {
    type: 'PUSH',
    target: navigator.key,
    payload: { name: '[hostId]/index', params: { hostId } }
  })
}

function clone(state: MutableState): MutableState {
  return JSON.parse(JSON.stringify(state)) as MutableState
}

/** Wires the production owner to the model: state reads, dispatches, and pushes all
 *  land on one live tree, and every mutation re-notifies the owner's state listener. */
function drive(initial: MutableState) {
  const root = clone(initial)
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of new Set(listeners)) {
      listener()
    }
  }
  const queued: string[] = []
  const push = vi.fn((route: string) => {
    queued.push(decodeURIComponent(route.slice('/h/'.length)))
  })
  const navigation = {
    addListener: (_event: 'state', listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch: vi.fn((action: StackAction) => {
      applyToNavigator(root, action)
      notify()
    }),
    getState: () => root as unknown as HostStackNavigationState
  }
  const replace = vi.fn((href: { pathname: string; params: Record<string, string> }) => {
    const navigator = divergentNavigator(root, String(href.params.hostId))
    applyToNavigator(root, {
      type: 'REPLACE',
      target: navigator.key,
      payload: { name: href.pathname.slice('/h/'.length), params: href.params }
    })
    notify()
  })
  return {
    root,
    navigation,
    router: { push, replace } as never,
    push,
    dispatch: navigation.dispatch,
    open(hostId: string, target: HostStackRouteTarget) {
      return navigateToHostStackRoute(navigation as never, this.router, hostId, target)
    },
    /** What a screen that owns its own cold-start navigation calls first. */
    converge(target: HostStackRouteTarget) {
      return convergeOnMountedHostStackRoute(navigation as never, target)
    },
    /** Commit the queued pushes, the way expo-router drains its routing queue. */
    settle() {
      while (queued.length > 0) {
        pushHostRoute(root, queued.shift()!)
        notify()
      }
    },
    hydrate(next: MutableState) {
      root.key = next.key
      root.index = next.index
      root.routes = next.routes
      notify()
    }
  }
}

function collectRoutes(state: MutableState, out: MutableRoute[] = []): MutableRoute[] {
  for (const route of state.routes) {
    out.push(route)
    if (route.state) {
      collectRoutes(route.state, out)
    }
  }
  return out
}

/** Every MOUNTED session screen for this worktree, wherever it sits in the tree. */
function mountedSessions(state: MutableState, worktreeId: string): MutableRoute[] {
  return collectRoutes(state).filter(
    (route) =>
      route.name === '[hostId]/session/[worktreeId]' && route.params?.worktreeId === worktreeId
  )
}

const HOST = 'host/one'
const WORKTREE = 'repo::/tmp/wt'
const TARGET = mobileSessionRouteTarget({ hostId: HOST, worktreeId: WORKTREE })

function sessionRoute(key: string, hostId = HOST, worktreeId = WORKTREE): MutableRoute {
  return {
    key,
    name: '[hostId]/session/[worktreeId]',
    params: { hostId, worktreeId }
  }
}

function tree(hostStack: { index: number; routes: MutableRoute[] }): MutableState {
  return {
    key: 'root',
    index: 0,
    routes: [{ key: 'h-1', name: 'h', state: { key: 'h-stack', ...hostStack } }]
  }
}

describe('one mounted session screen per worktree', () => {
  it('converges before a review screen can contend for the terminal input lease', () => {
    // Source Control stacked over a live session, then a changed file opened for review.
    // `Open in session` used to router.replace() here, and REPLACE mints a fresh key.
    const app = drive(
      tree({
        index: 2,
        routes: [
          sessionRoute('live-session'),
          {
            key: 'source-control',
            name: '[hostId]/source-control/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE }
          },
          {
            key: 'review',
            name: '[hostId]/review/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE }
          }
        ]
      })
    )

    expect(app.converge(TARGET)).toBe(true)

    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions.map((route) => route.key)).toEqual(['live-session'])
    expect(app.root.routes[0].state?.index).toBe(0)
  })

  it('converges a worktree row tap onto the session already mounted under the host list', () => {
    // A host-level notification pushes `/h/<host>`, which appends a SECOND `[hostId]/index`
    // above the live session; the row tap below it would otherwise push a second session.
    const app = drive(
      tree({
        index: 2,
        routes: [
          { key: 'idx', name: '[hostId]/index', params: { hostId: HOST } },
          sessionRoute('live-session'),
          { key: 'idx-2', name: '[hostId]/index', params: { hostId: HOST } }
        ]
      })
    )

    expect(app.converge(TARGET)).toBe(true)

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
  })

  it('reports no convergence when the worktree is not mounted, so the caller still navigates', () => {
    const app = drive(
      tree({ index: 0, routes: [{ key: 'idx', name: '[hostId]/index', params: { hostId: HOST } }] })
    )

    expect(app.converge(TARGET)).toBe(false)
    expect(mountedSessions(app.root, WORKTREE)).toHaveLength(0)
  })

  // Why the extra params: every real entry point puts presentation state in the query
  // (`?name=…`, `created=1`, `warning=…`), so the mounted route carries params the
  // convergence target does not. Identity is the host and worktree alone; comparing the
  // whole param set would miss the live screen and mount a second one beside it.
  it('converges onto a session mounted with presentation params the target omits', () => {
    const app = drive(
      tree({
        index: 1,
        routes: [
          {
            key: 'live-session',
            name: '[hostId]/session/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE, name: 'Repo one', created: '1' }
          },
          {
            key: 'files',
            name: '[hostId]/files/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE }
          }
        ]
      })
    )

    app.open(HOST, TARGET)
    app.settle()

    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].key).toBe('live-session')
    // Recognising the screen is only half of it: the tap has to land on it. The count
    // alone still passes when convergence reports a hit and then dispatches nothing,
    // leaving the user on the Files screen it was supposed to pop back through.
    const hostStack = app.root.routes[0].state
    expect(hostStack?.routes[hostStack.index].key).toBe('live-session')
  })

  it('does not mount a second session when the tap arrives from Files for the same worktree', () => {
    const app = drive(
      tree({
        index: 1,
        routes: [
          sessionRoute('live-session'),
          {
            key: 'files',
            name: '[hostId]/files/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE }
          }
        ]
      })
    )

    app.open(HOST, TARGET)
    app.settle()

    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions).toHaveLength(1)
    // Same key ⇒ the live screen was revealed, not remounted, so its terminal
    // subscription and input lease are the ones still on screen.
    expect(sessions[0].key).toBe('live-session')
    expect(app.root.routes[0].state?.routes.map((route) => route.key)).toEqual(['live-session'])
    expect(app.root.routes[0].state?.index).toBe(0)
  })

  it('does not mount a second session when the tap arrives from source control', () => {
    const app = drive(
      tree({
        index: 1,
        routes: [
          sessionRoute('live-session'),
          {
            key: 'source-control',
            name: '[hostId]/source-control/[worktreeId]',
            params: { hostId: HOST, worktreeId: WORKTREE }
          }
        ]
      })
    )

    app.open(HOST, TARGET)
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
  })

  it('leaves the already-focused session exactly as it was', () => {
    const app = drive(tree({ index: 0, routes: [sessionRoute('live-session')] }))
    const before = clone(app.root)

    app.open(HOST, TARGET)
    app.settle()

    expect(app.root).toEqual(before)
    expect(app.push).not.toHaveBeenCalled()
    expect(app.dispatch).not.toHaveBeenCalled()
  })

  it('does not mount a second session when the user is on a root route above the host stack', () => {
    const app = drive({
      key: 'root',
      index: 2,
      routes: [
        { key: 'home', name: 'index' },
        {
          key: 'h-1',
          name: 'h',
          state: { key: 'h-stack', index: 0, routes: [sessionRoute('live-session')] }
        },
        { key: 'settings', name: 'settings' }
      ]
    })

    app.open(HOST, TARGET)
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
    expect(collectRoutes(app.root).filter((route) => route.name === 'h')).toHaveLength(1)
    expect(app.root.routes.map((route) => route.key)).toEqual(['home', 'h-1'])
  })

  it('collapses a stack that already carries duplicate session screens', () => {
    const app = drive(
      tree({ index: 1, routes: [sessionRoute('first-session'), sessionRoute('second-session')] })
    )

    app.open(HOST, TARGET)
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['first-session'])
  })

  it('still mounts the session on a cold start with no host stack', () => {
    const app = drive({ key: 'root', index: 0, routes: [{ key: 'home', name: 'index' }] })

    app.open(HOST, TARGET)
    app.settle()

    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].params).toEqual({ hostId: HOST, worktreeId: WORKTREE })
    expect(app.push).toHaveBeenCalledTimes(1)
  })

  it('mounts a genuinely different worktree alongside the live one', () => {
    const app = drive(tree({ index: 0, routes: [sessionRoute('live-session')] }))
    const other = 'repo::/tmp/other'

    app.open(HOST, mobileSessionRouteTarget({ hostId: HOST, worktreeId: other }))
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
    expect(mountedSessions(app.root, other)).toHaveLength(1)
  })

  it('does not treat a percent-encoded host id as the host it decodes to', () => {
    const aliased = 'host%2Fone'
    const app = drive(
      tree({ index: 0, routes: [sessionRoute('other-host-session', aliased, WORKTREE)] })
    )

    app.open(HOST, TARGET)
    app.settle()

    // Two distinct hosts, so two session screens — converging here would strand the
    // tap on a different host's chat.
    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions).toHaveLength(2)
    expect(sessions.map((route) => route.params?.hostId)).toEqual([aliased, HOST])
  })

  it('does not converge onto a host stack whose id merely percent-encodes to the one opened', () => {
    // `host%2Fone` is a DIFFERENT host: expo-router decodes `/h/host%2Fone` to `host/one`
    // and `/h/host%252Fone` to `host%2Fone`, so the two never share a route param. The
    // push armed here has not committed yet, so the hydrated stack is not ours to replace.
    const aliased = 'host%2Fone'
    const app = drive({ key: 'root', index: 0, routes: [] })
    const controller = app.open(HOST, TARGET)
    expect(app.push).toHaveBeenCalledTimes(1)

    app.hydrate(
      clone(
        tree({
          index: 0,
          routes: [{ key: 'aliased-index', name: '[hostId]/index', params: { hostId: aliased } }]
        })
      )
    )

    expect(app.dispatch).not.toHaveBeenCalled()
    expect(controller.isActive()).toBe(true)

    app.settle()

    // The other host's screen is still mounted, still its own, and was never the REPLACE
    // source; our session landed on the `[hostId]/index` our own push committed.
    expect(app.root.routes[0].state?.routes[0]).toEqual({
      key: 'aliased-index',
      name: '[hostId]/index',
      params: { hostId: aliased }
    })
    expect(app.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REPLACE', source: 'aliased-index' })
    )
    const sessions = mountedSessions(app.root, WORKTREE)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].params).toEqual({ hostId: HOST, worktreeId: WORKTREE })
  })

  it('converges after a push armed before hydration lands over an already-mounted session', () => {
    // The notification tap can arm before the root navigator has committed any state,
    // so the entry read sees nothing and the `/h/<host>` push goes out regardless.
    const app = drive({ key: 'root', index: 0, routes: [] })
    const controller = app.open(HOST, TARGET)
    expect(controller.isActive()).toBe(true)
    expect(app.push).toHaveBeenCalledTimes(1)

    app.hydrate(
      clone(
        tree({
          index: 1,
          routes: [
            sessionRoute('live-session'),
            {
              key: 'files',
              name: '[hostId]/files/[worktreeId]',
              params: { hostId: HOST, worktreeId: WORKTREE }
            }
          ]
        })
      )
    )
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
    expect(app.root.routes[0].state?.routes.map((route) => route.name)).toEqual([
      '[hostId]/session/[worktreeId]'
    ])
    expect(controller.isActive()).toBe(false)
  })

  it('converges when a pending transition is retargeted onto an already-mounted session', () => {
    const app = drive(
      tree({
        index: 1,
        routes: [
          sessionRoute('live-session'),
          { key: 'tasks', name: '[hostId]/tasks', params: { hostId: HOST, taskSource: 'linear' } }
        ]
      })
    )
    const controller = app.open(HOST, { name: '[hostId]/tasks', params: { hostId: HOST } })
    expect(controller.isActive()).toBe(true)

    controller.retarget(TARGET)
    app.settle()

    expect(mountedSessions(app.root, WORKTREE).map((route) => route.key)).toEqual(['live-session'])
    expect(app.root.routes[0].state?.routes.map((route) => route.name)).toEqual([
      '[hostId]/session/[worktreeId]'
    ])
    expect(controller.isActive()).toBe(false)
  })
})
