import { useMemo } from 'react'
import { useRouteHandoff, type RouteHandoff } from './route-handoff'
import { useWorkspaceExecutionHost, workspaceHref } from './workspace-execution-host'

/**
 * The route handoff for a screen whose pushes all open this workspace's own screens, so each one
 * stays on the workspace's server. A screen that also leaves the workspace keeps the plain handoff.
 */
export function useWorkspaceRouteHandoff(): RouteHandoff {
  const router = useRouteHandoff()
  const executionHost = useWorkspaceExecutionHost()
  return useMemo<RouteHandoff>(
    () =>
      executionHost
        ? {
            ...router,
            push: (href, options) => router.push(workspaceHref(href, executionHost), options),
            navigate: (href, options) =>
              router.navigate(workspaceHref(href, executionHost), options),
            replace: (href, options) => router.replace(workspaceHref(href, executionHost), options)
          }
        : router,
    [executionHost, router]
  )
}
