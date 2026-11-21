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
import { terminalTabPaneKey } from '../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'

/** Shows a terminal resumed from history in its session, selecting it rather than the session's previous tab. */
export function openResumedHistoryTerminal(args: {
  router: Pick<RouteHandoff, 'back' | 'replace'>
  /** The session screen below in this document, when there is one. */
  sessionBelow: SessionScreenHandlers | undefined
  shell: ShellSessionHandoff
  hostId: string
  /** The workspace's server; the router adds it itself, the shell href must carry it to find the session entry. */
  executionHost: ExecutionHostId | undefined
  worktreeId: string
  resumed: { id: string; terminal: string; parentTabId?: string; leafId?: string }
  /** History was opened from this same session, so Back lands on its entry. */
  fromSession: boolean
}): void {
  const { router, sessionBelow, shell, resumed, fromSession } = args
  if (fromSession && sessionBelow) {
    sessionBelow.onResumedTerminal(resumed.terminal)
    return router.back()
  }
  // Older shells push a second session entry for a pane href instead of returning to the existing one.
  const paneKey = shell?.returns() ? terminalTabPaneKey(resumed) : undefined
  const href = stringifyRouteHref({
    pathname: '/h/[hostId]/session/[worktreeId]',
    params: { hostId: args.hostId, worktreeId: args.worktreeId, ...(paneKey ? { paneKey } : {}) }
  })
  if (!fromSession) {
    return router.replace(href)
  }
  // Ask the shell even when this page serves the route, so the pane lands on the existing native entry, not a second session here.
  if (shell && paneKey) {
    return shell.open(workspaceRouteHref(href, args.executionHost))
  }
  router.back()
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
  const router = useWorkspaceRouteHandoff()
  const sessionBelow = useSessionScreenHandlers(hostId, worktreeId)
  const shell = useShellSessionHandoff()
  const executionHost = useWorkspaceExecutionHost()
  return useCallback(
    (terminal) =>
      openResumedHistoryTerminal({
        router,
        sessionBelow,
        shell,
        hostId,
        executionHost,
        ...terminal
      }),
    [router, sessionBelow, shell, hostId, executionHost]
  )
}
