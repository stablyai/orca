import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../test-support/rpc-recording/hook-mount'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { useMobileDiffReviewSnapshot } from '../session/use-mobile-diff-review-snapshot'

const focus = vi.hoisted(() => ({ current: true }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) =>
    useEffect(() => (focus.current ? effect() : undefined), [effect, focus.current])
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

it('shows what Review staged when returning to Changes without remounting the screen', async () => {
  const client = createFakeRpcClient()
  const clearError = () => {}
  let tree: ReactTestRenderer | null = null
  const read: {
    loaders: ReturnType<typeof useMobileSourceControlLoaders> | null
    review: ReturnType<typeof useMobileDiffReviewSnapshot> | null
  } = { loaders: null, review: null }
  const queries = documentQueryClient()
  const screen = (reviewOpen = false) => queries.wrap(createElement(Screen, { reviewOpen }))
  function Screen({ reviewOpen }: { reviewOpen: boolean }) {
    read.loaders = useMobileSourceControlLoaders({
      hostId: 'host',
      client,
      connState: 'connected',
      statusIdentityKey: 'host:wt',
      worktreeId: 'wt',
      setActionError: clearError
    })
    return reviewOpen ? createElement(Review) : null
  }
  function Review() {
    read.review = useMobileDiffReviewSnapshot({
      client,
      connState: 'connected',
      hostId: 'host',
      worktreeId: 'wt',
      commitOid: null,
      filter: 'unstaged',
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
    await settleQueryNotifications()
  }
  try {
    await act(async () => {
      tree = create(screen())
    })
    await resolveStatus('unstaged')
    expect(read.loaders?.screenState).toMatchObject({
      kind: 'ready',
      status: { entries: [{ area: 'unstaged' }] }
    })
    focus.current = false
    await act(async () => {
      tree?.update(screen(true))
    })
    // Review's read after its stage lands in the entry Changes shows.
    let reloading: Promise<void> | undefined
    await act(async () => {
      reloading = read.review?.loadReviewData()
    })
    await resolveStatus('staged')
    await act(async () => {
      await reloading
    })
    focus.current = true
    await act(async () => {
      tree?.update(screen())
    })
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
