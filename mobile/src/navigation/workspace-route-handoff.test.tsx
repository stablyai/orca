import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => {
  const opened: unknown[] = []
  const router = {
    push: (href: unknown, options?: unknown) => opened.push(['push', href, options]),
    replace: (href: unknown, options?: unknown) => opened.push(['replace', href, options]),
    navigate: (href: unknown, options?: unknown) => opened.push(['navigate', href, options]),
    back: () => opened.push(['back'])
  }
  const state: { opened: unknown[]; router: typeof router } = {
    opened,
    router
  }
  return state
})

vi.mock('./route-handoff', () => ({ useRouteHandoff: () => route.router }))

import { useWorkspaceRouteHandoff } from './workspace-route-handoff'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from './workspace-execution-host'

const trees: ReactTestRenderer[] = []

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})

async function workspaceRouterFor(
  params: Record<string, string>
): Promise<ReturnType<typeof useWorkspaceRouteHandoff>> {
  route.opened.length = 0
  const held: { router: ReturnType<typeof useWorkspaceRouteHandoff> | null } = { router: null }
  function Probe(): null {
    held.router = useWorkspaceRouteHandoff()
    return null
  }
  await act(async () => {
    trees.push(
      create(
        createElement(
          WorkspaceExecutionHostContext.Provider,
          { value: normalizeExecutionHostId(params.executionHost) ?? undefined },
          createElement(Probe)
        )
      )
    )
  })
  if (!held.router) {
    throw new Error('probe did not render')
  }
  return held.router
}

describe('a workspace screen’s router', () => {
  it('keeps every screen it opens on the workspace’s server', async () => {
    const router = await workspaceRouterFor({ executionHost: 'runtime:vm' })
    const options = { withAnchor: false }
    router.push('/h/host-1/review/wt?name=api', options)
    router.replace('/h/host-1/session/wt', options)
    router.navigate(
      { pathname: '/h/[hostId]/files/[worktreeId]', params: { hostId: 'host-1' } },
      options
    )
    router.back()
    expect(route.opened).toEqual([
      ['push', '/h/host-1/review/wt?name=api&executionHost=runtime%3Avm', options],
      ['replace', '/h/host-1/session/wt?executionHost=runtime%3Avm', options],
      [
        'navigate',
        {
          pathname: '/h/[hostId]/files/[worktreeId]',
          params: { hostId: 'host-1', executionHost: 'runtime:vm' }
        },
        options
      ],
      ['back']
    ])
  })

  it('is the plain router in the desktop’s own workspaces', async () => {
    const router = await workspaceRouterFor({})
    expect(router).toBe(route.router)
  })
})
