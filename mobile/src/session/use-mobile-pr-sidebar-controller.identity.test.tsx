import React, { useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useMobilePrSidebarController,
  type MobilePrSidebarController
} from './use-mobile-pr-sidebar-controller'
import { isPrSidebarDetailsPlaceholder } from './mobile-pr-sidebar-state'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'

vi.mock('../i18n/mobile-i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
})
const repo = (owner: string) => ({ owner, repo: 'widgets', host: 'github.corp' })
const pr = (owner: string) => ({
  number: 93,
  state: 'open',
  title: owner,
  url: `https://github.corp/${owner}/widgets/pull/93`,
  prRepo: repo(owner),
  headSha: `${owner}-head`
})
const details = (owner: string) => ({
  item: { ...pr(owner), id: `PR_${owner}`, type: 'pr', labels: [], updatedAt: '', author: null },
  body: `${owner} body`,
  comments: [],
  files: [{ path: `${owner}.ts` }],
  pullRequestId: `PR_${owner}`,
  headSha: `${owner}-head`
})

it('runs phase-two failure, Retry, prior isolation and late A/B claim settlement through the production controller and decoders', async () => {
  let generation = 1
  const client = createFakeRpcClient({ getGeneration: () => generation })
  const pending: { owner: string; resolve: (reply: RpcResponse) => void }[] = []
  let owner = 'fork'
  client.sendRequest = async (method, params) => {
    const result =
      method === 'github.repoSlug'
        ? repo(owner)
        : method === 'worktree.show'
          ? { worktree: { branch: 'feat' } }
          : method === 'hostedReview.forBranch'
            ? null
            : method === 'github.prForBranch'
              ? pr(owner)
              : method === 'github.prChecks'
                ? []
                : method === 'status.get'
                  ? {
                      runtimeId: 'a',
                      hostDescriptor: { installationId: 'a' },
                      capabilities: ['github.exact-work-item-target.v1']
                    }
                  : undefined
    if (method === 'github.workItemDetails') {
      expect(params).toMatchObject({ number: 93, type: 'pr', ownerRepo: repo(owner) })
      return new Promise((resolve) => pending.push({ owner, resolve }))
    }
    if (result === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, result)
  }
  const beforeEffects: string[] = []
  let controller: MobilePrSidebarController
  function Probe() {
    controller = useMobilePrSidebarController({
      client,
      connState: 'connected',
      worktreeId: 'clone::/wt',
      branch: 'feat',
      headSha: 'head'
    })
    useLayoutEffect(() => {
      beforeEffects.push(controller.prSidebarState.kind)
    }, [generation])
    return null
  }
  await act(async () => {
    renderer = create(<Probe />)
  })
  await act(async () => controller.openPRSidebar())
  expect(pending).toHaveLength(1)
  await act(async () => pending.shift()!.resolve(rpcSuccess('wrong', details('upstream'))))
  expect(controller!.prSidebarState.kind).toBe('ready')
  if (controller!.prSidebarState.kind !== 'ready') {
    throw new Error('sidebar not ready')
  }
  expect(isPrSidebarDetailsPlaceholder(controller!.prSidebarState.data.details!)).toBe(true)
  await act(async () => controller.retryPRSidebar())
  expect(pending).toHaveLength(1)
  await act(async () => pending.shift()!.resolve(rpcSuccess('matching', details('fork'))))
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'fork body', pullRequestId: 'PR_fork' } }
  })
  await act(async () => controller.retryPRSidebar())
  const lateA = pending.shift()!
  owner = 'upstream'
  await act(async () => controller.retryPRSidebar())
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { pr: { title: 'upstream' }, details: null }
  })
  expect(pending).toHaveLength(1)
  await act(async () => lateA.resolve(rpcSuccess('late-a', details('fork'))))
  await act(async () => controller.ensurePrSidebarDetails())
  // A released its own claim, never B's: ensure must deduplicate B.
  expect(pending).toHaveLength(1)
  await act(async () => pending.shift()!.resolve(rpcSuccess('matching-b', details('upstream'))))
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'upstream body', pullRequestId: 'PR_upstream' } }
  })

  await act(async () => controller.retryPRSidebar())
  expect(pending).toHaveLength(1)
  const oldGeneration = pending.shift()!
  generation += 1
  await act(async () => renderer!.update(<Probe />))
  // Layout sees the existing ready render; the original passive reset then hides it.
  expect(beforeEffects).toEqual(['hidden', 'ready'])
  expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
  await act(async () => oldGeneration.resolve(rpcSuccess('old-generation', details('upstream'))))
  expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
  owner = 'new-generation'
  await act(async () => controller.openPRSidebar())
  expect(pending).toHaveLength(1)
  await act(async () =>
    pending.shift()!.resolve(rpcSuccess('current-generation', details('new-generation')))
  )
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: {
      pr: { title: 'new-generation' },
      details: { body: 'new-generation body', pullRequestId: 'PR_new-generation' }
    }
  })
})
