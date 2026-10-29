import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'

const focus = vi.hoisted(() => ({ current: true }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) =>
    useEffect(() => {
      if (focus.current) {
        effect()
      }
    }, [effect, focus.current])
}))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ArrowDownUp: 'ArrowDownUp',
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  CloudUpload: 'CloudUpload',
  GitBranch: 'GitBranch',
  GitPullRequestArrow: 'GitPullRequestArrow',
  History: 'History',
  RefreshCw: 'RefreshCw'
}))

it('refreshes the staging area when returning from review without remounting the screen', async () => {
  const client = createFakeRpcClient()
  const clearError = () => {}
  let tree: ReactTestRenderer | null = null
  const read: { loaders: ReturnType<typeof useMobileSourceControlLoaders> | null } = {
    loaders: null
  }
  function Screen() {
    read.loaders = useMobileSourceControlLoaders({
      client,
      connState: 'connected',
      statusIdentityKey: 'host:wt',
      worktreeId: 'wt',
      setActionError: clearError
    })
    return null
  }
  async function resolveStatus(area: string) {
    const request = client.requests.findLast((request) => request.method === 'git.status')
    if (!request) {
      throw new Error('Expected status refresh')
    }
    await act(async () =>
      request.resolve(
        rpcSuccess('status', { entries: [{ path: 'app.ts', status: 'modified', area }] })
      )
    )
  }
  try {
    await act(async () => {
      tree = create(createElement(Screen))
    })
    await resolveStatus('unstaged')
    expect(read.loaders?.screenState).toMatchObject({
      kind: 'ready',
      status: { entries: [{ area: 'unstaged' }] }
    })
    focus.current = false
    await act(async () => {
      tree?.update(createElement(Screen))
    })
    const beforeReturn = client.requests.filter((request) => request.method === 'git.status').length
    focus.current = true
    await act(async () => {
      tree?.update(createElement(Screen))
    })
    expect(client.requests.filter((request) => request.method === 'git.status')).toHaveLength(
      beforeReturn + 1
    )
    await resolveStatus('staged')
    expect(read.loaders?.screenState).toMatchObject({
      kind: 'ready',
      status: { entries: [{ area: 'staged' }] }
    })
  } finally {
    await act(async () => {
      tree?.unmount()
    })
  }
})
