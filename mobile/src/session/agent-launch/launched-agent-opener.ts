import { useNavigation } from 'expo-router'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import { HOST_SESSION_ROUTE } from '../../navigation/host-stack-navigation'
import { stringifyRouteHref } from '../../navigation/route-href'
import { useShellSessionHandoff } from '../../navigation/route-handoff'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../../navigation/workspace-route-handoff'

/** Where the host put a launched agent; paneKey is null when the host named no pane. */
export type LaunchedAgentOpens = Readonly<{
  worktreeId: string
  paneKey: string | null
}>

type StackEntry = Readonly<{ name: string; params?: object }>

// Raw ids, as the host names them and as a stack entry's params hold them: Expo's parser decodes each path segment once, so they are compared as-is and never decoded again.
type SessionIdentity = Readonly<{
  hostId: string
  worktreeId: string
  executionHost: ExecutionHostId | undefined
}>

export type LaunchedAgentOpenPlan =
  | { kind: 'set-params' }
  | { kind: 'dismiss-to'; href: string }
  | { kind: 'shell'; href: string }
  | { kind: 'push'; href: string }
  | { kind: 'none' }

const SESSION_PATHNAME = '/h/[hostId]/session/[worktreeId]'

function stringParams(entry: StackEntry): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entry.params ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
    )
  )
}

function showsSession(entry: StackEntry, session: SessionIdentity): boolean {
  const params = stringParams(entry)
  return (
    params.hostId === session.hostId &&
    params.worktreeId === session.worktreeId &&
    (params.executionHost ?? '') === (session.executionHost ?? '')
  )
}

// A session is (host, workspace, execution host); the pane is a request delivered to the entry that already shows it, never a second entry.
export function planLaunchedAgentOpen(args: {
  /** This document's stack, bottom first. */
  stack: readonly StackEntry[]
  /** Index of the screen offering the link. */
  current: number
  session: SessionIdentity
  paneKey: string
  /** Null without a shell; otherwise whether the shell returns to a session's existing native entry. */
  shellReturns: boolean | null
}): LaunchedAgentOpenPlan {
  const { stack, current, session, paneKey, shellReturns } = args
  // POP_TO lands on the nearest entry of this name, so only that one may be this session.
  const nearest = stack.findLastIndex(
    (entry, index) => index <= current && entry.name === HOST_SESSION_ROUTE
  )
  const entry = stack[nearest]
  if (entry && showsSession(entry, session)) {
    return nearest === current
      ? { kind: 'set-params' }
      : {
          kind: 'dismiss-to',
          href: stringifyRouteHref({
            pathname: SESSION_PATHNAME,
            params: { ...stringParams(entry), paneKey }
          })
        }
  }
  if (shellReturns === false) {
    return { kind: 'none' }
  }
  const href = stringifyRouteHref({
    pathname: SESSION_PATHNAME,
    params: {
      hostId: session.hostId,
      worktreeId: session.worktreeId,
      paneKey,
      ...(session.executionHost ? { executionHost: session.executionHost } : {})
    }
  })
  return { kind: shellReturns ? 'shell' : 'push', href }
}

type StackNavigation = {
  getState: () => { index?: number; routeNames?: readonly string[]; routes: readonly StackEntry[] }
  getParent: () => StackNavigation | undefined
}

// The host stack is the navigator that declares the session screen; a nested navigator's state would hide it.
function hostStackOf(navigation: StackNavigation | undefined): {
  stack: readonly StackEntry[]
  current: number
} {
  for (let level = navigation; level; level = level.getParent()) {
    const state = level.getState()
    if (state.routeNames?.includes(HOST_SESSION_ROUTE)) {
      return { stack: state.routes, current: state.index ?? state.routes.length - 1 }
    }
  }
  return { stack: [], current: -1 }
}

/** Opens the launched agent's pane in its session; null when there is no pane or no clean way back to it. */
export function useLaunchedAgentOpener(opens: LaunchedAgentOpens | null): (() => void) | null {
  const navigation = useNavigation<StackNavigation>()
  const router = useWorkspaceRouteHandoff()
  const shell = useShellSessionHandoff()
  const executionHost = useWorkspaceExecutionHost()
  const paneKey = opens?.paneKey
  if (!opens || !paneKey) {
    return null
  }
  // Planned again at the press: the stack and the shell's grants are read, not subscribed to.
  const plan = (): LaunchedAgentOpenPlan => {
    const host = hostStackOf(navigation)
    // This screen's own entry holds the raw host id; useLocalSearchParams would decode it a second time.
    const self = host.stack[host.current]
    const hostId = self && stringParams(self).hostId
    return hostId === undefined
      ? { kind: 'none' }
      : planLaunchedAgentOpen({
          ...host,
          session: { hostId, worktreeId: opens.worktreeId, executionHost },
          paneKey,
          shellReturns: shell && shell.returns()
        })
  }
  if (plan().kind === 'none') {
    return null
  }
  return () => {
    const step = plan()
    switch (step.kind) {
      case 'set-params':
        return router.setParams({ paneKey })
      case 'dismiss-to':
        return router.dismissTo(step.href)
      case 'shell':
        return shell?.open(step.href)
      case 'push':
        return router.push(step.href)
      case 'none':
        return undefined
    }
  }
}
