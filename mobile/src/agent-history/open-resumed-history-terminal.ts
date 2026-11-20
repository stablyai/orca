import { useCallback } from 'react'
import {
  useShellSessionHandoff,
  type RouteHandoff,
  type ShellSessionHandoff
} from '../navigation/route-handoff'
import { stringifyRouteHref } from '../navigation/route-href'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import {
  useSessionScreenHandlers,
  type SessionScreenHandlers
} from '../session/session-screen-handlers'
import { terminalTabPaneKey } from '../session/tabs/notification-pane-tab'

type HistoryNavigation = {
  router: Pick<RouteHandoff, 'back' | 'replace'>
  sessionBelow: SessionScreenHandlers | undefined
  shell: ShellSessionHandoff
  hostId: string
  executionHost: ExecutionHostId | undefined
}

type HistorySessionDestination = {
  worktreeId: string
  paneKey?: string
  terminal?: string
  fromSession: boolean
}

/** Returns to the owning session entry; older shells keep their Back behavior. */
export function openHistorySessionPane(args: HistoryNavigation & HistorySessionDestination): void {
  const { router, sessionBelow, shell, terminal, fromSession } = args
  if (fromSession && sessionBelow && terminal) {
    sessionBelow.onResumedTerminal(terminal)
    return router.back()
  }
  // Older shells push a second session entry for a pane href instead of returning to the existing one.
  const paneKey = shell?.returns() ? args.paneKey : undefined
  const href = stringifyRouteHref({
    pathname: '/h/[hostId]/session/[worktreeId]',
    params: { hostId: args.hostId, worktreeId: args.worktreeId, ...(paneKey ? { paneKey } : {}) }
  })
  if (!fromSession) {
    return router.replace(href)
  }
  // The existing session lives on the native stack, even when this page can serve its route.
  if (shell && paneKey) {
    return shell.open(workspaceRouteHref(href, args.executionHost))
  }
  router.back()
}

export function openResumedHistoryTerminal(
  args: HistoryNavigation & {
    worktreeId: string
    resumed: { id: string; terminal?: string | null; parentTabId?: string; leafId?: string }
    fromSession: boolean
  }
): void {
  openHistorySessionPane({
    ...args,
    terminal: args.resumed.terminal ?? undefined,
    paneKey: terminalTabPaneKey(args.resumed)
  })
}

export function useHistorySessionPaneOpener(hostId: string, worktreeId: string) {
  const router = useWorkspaceRouteHandoff()
  const sessionBelow = useSessionScreenHandlers(hostId, worktreeId)
  const shell = useShellSessionHandoff()
  const executionHost = useWorkspaceExecutionHost()
  return useCallback(
    (destination: HistorySessionDestination) =>
      openHistorySessionPane({
        router,
        sessionBelow,
        shell,
        hostId,
        executionHost,
        ...destination
      }),
    [router, sessionBelow, shell, hostId, executionHost]
  )
}

type ResumedHistoryTerminal = Pick<
  Parameters<typeof openResumedHistoryTerminal>[0],
  'worktreeId' | 'resumed' | 'fromSession'
>

/** Opens terminals resumed from this session's history screen. */
export function useResumedHistoryTerminalOpener(
  hostId: string,
  worktreeId: string
): (terminal: ResumedHistoryTerminal) => void {
  const open = useHistorySessionPaneOpener(hostId, worktreeId)
  return useCallback(
    (args: ResumedHistoryTerminal) =>
      open({
        worktreeId: args.worktreeId,
        terminal: args.resumed.terminal ?? undefined,
        paneKey: terminalTabPaneKey(args.resumed),
        fromSession: args.fromSession
      }),
    [open]
  )
}
