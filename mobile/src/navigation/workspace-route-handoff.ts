import { useMemo } from 'react'
import { useRouteHandoff, type RouteHandoff } from './route-handoff'
import { useWorkspaceExecutionHost, workspaceHref } from './workspace-execution-host'

// Keep workspace-only pushes on this workspace’s server; screens that leave it must use plain route handoff.
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
