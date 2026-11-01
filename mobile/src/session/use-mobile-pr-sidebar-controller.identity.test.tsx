import React, { Suspense, startTransition, useLayoutEffect } from 'react'
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
  await act(async () => client.pushState('connected'))
  // A generation change keeps the same resource and starts its successor before the old reply settles.
  expect(beforeEffects).toEqual(['hidden', 'ready'])
  expect(pending).toHaveLength(1)
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'upstream body', pullRequestId: 'PR_upstream' } }
  })
  await act(async () =>
    oldGeneration.resolve(
      rpcSuccess('old-generation', { ...details('upstream'), body: 'retired body' })
    )
  )
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'upstream body' } }
  })
  await act(async () => client.pushState('connected'))
  expect(pending).toHaveLength(1)
  await act(async () =>
    pending
      .shift()!
      .resolve(rpcSuccess('current-generation', { ...details('upstream'), body: 'refreshed body' }))
  )
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { pr: { title: 'upstream' }, details: { body: 'refreshed body' } }
  })

  // A down/up pair in one batch at an unchanged generation still retires and recovers.
  await act(async () => controller.retryPRSidebar())
  const beforeDrop = pending.shift()!
  await act(async () => {
    client.pushState('disconnected')
    client.pushState('connected')
  })
  expect(pending).toHaveLength(1)
  await act(async () =>
    beforeDrop.resolve(rpcSuccess('before-drop', { ...details('upstream'), body: 'dropped body' }))
  )
  await act(async () =>
    pending
      .shift()!
      .resolve(rpcSuccess('after-drop', { ...details('upstream'), body: 'recovered body' }))
  )
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'recovered body' } }
  })
})

it('selects fresh branch/client observations and keeps the same one across a generation change while old phase-one, phase-two and ensure work remains pending', async () => {
  let generation = 1
  let branch: string | null = 'a'
  let responseOwner = 'a'
  let holdPhaseOne = false
  const phaseOne: ((reply: RpcResponse) => void)[] = []
  const pendingDetails: { owner: string; resolve: (reply: RpcResponse) => void }[] = []
  let client = createFakeRpcClient({ getGeneration: () => generation })
  const sendRequest: typeof client.sendRequest = async (method) => {
    if (method === 'github.prForBranch' && holdPhaseOne) {
      holdPhaseOne = false
      return new Promise((resolve) => phaseOne.push(resolve))
    }
    if (method === 'github.workItemDetails') {
      return new Promise((resolve) => pendingDetails.push({ owner: responseOwner, resolve }))
    }
    const value =
      method === 'github.repoSlug'
        ? repo(responseOwner)
        : method === 'worktree.show'
          ? { worktree: { branch } }
          : method === 'hostedReview.forBranch'
            ? null
            : method === 'github.prForBranch'
              ? pr(responseOwner)
              : method === 'github.prChecks'
                ? []
                : method === 'status.get'
                  ? {
                      runtimeId: 'a',
                      hostDescriptor: { installationId: 'a' },
                      capabilities: ['github.exact-work-item-target.v1']
                    }
                  : undefined
    if (value === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, value)
  }
  client.sendRequest = sendRequest
  let controller: MobilePrSidebarController
  const layouts: string[] = []
  function Probe() {
    controller = useMobilePrSidebarController({
      client,
      connState: 'connected',
      worktreeId: 'clone::/wt',
      branch,
      headSha: 'head'
    })
    useLayoutEffect(() => {
      layouts.push(controller.prSidebarState.kind)
    }, [client, branch, generation])
    return null
  }
  const update = async () => {
    await act(async () => renderer!.update(<Probe />))
  }
  const settleDetails = async (bodyOwner: string) => {
    const held = pendingDetails.shift()
    if (!held) {
      throw new Error('missing details request')
    }
    expect(held.owner).toBe(bodyOwner)
    await act(async () => held.resolve(rpcSuccess('details', details(bodyOwner))))
    expect(controller!.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { details: { body: `${bodyOwner} body` } }
    })
  }
  await act(async () => {
    renderer = create(<Probe />)
  })
  await act(async () => controller.openPRSidebar())
  await settleDetails('a')
  const aRepo =
    controller!.prSidebarState.kind === 'ready' ? controller!.prSidebarState.data.pr.prRepo : null
  const sameScopeRefetch = controller!.refetchPRSidebar
  await update()
  expect(controller!.refetchPRSidebar).toBe(sameScopeRefetch)
  expect(
    controller!.prSidebarState.kind === 'ready' && controller!.prSidebarState.data.pr.prRepo
  ).toBe(aRepo)

  holdPhaseOne = true
  await act(async () => {
    void controller.refetchPRSidebar()
  })
  expect(phaseOne).toHaveLength(1)
  branch = 'b'
  responseOwner = 'b'
  await update()
  expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
  expect(controller!.showPRSidebar).toBe(true)
  await act(async () => controller.openPRSidebar())
  await settleDetails('b')
  await act(async () => phaseOne.shift()!(rpcSuccess('late-phase-one', pr('a'))))
  expect(pendingDetails).toHaveLength(0)
  expect(controller!.prSidebarState).toMatchObject({ kind: 'ready', data: { pr: { title: 'b' } } })

  await act(async () => {
    void controller.retryPRSidebar()
  })
  const oldPhaseTwo = pendingDetails.shift()!
  branch = null
  await update()
  expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
  branch = 'a'
  responseOwner = 'a2'
  await update()
  await act(async () => controller.openPRSidebar())
  expect(pendingDetails).toHaveLength(1)
  await act(async () => oldPhaseTwo.resolve(rpcSuccess('old-phase-two', details('b'))))
  await act(async () => controller.ensurePrSidebarDetails())
  expect(pendingDetails).toHaveLength(1)
  await settleDetails('a2')

  // A new client starts immediately while the previous client's ensure is unresolved.
  branch = 'ensure'
  responseOwner = 'ensure-old'
  await update()
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  await act(async () => {
    void controller.ensurePrSidebarDetails()
  })
  const oldEnsure = pendingDetails.shift()!
  const oldClient = client
  client = createFakeRpcClient({ getGeneration: () => generation })
  client.sendRequest = sendRequest
  responseOwner = 'replacement'
  await update()
  expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
  expect(client).not.toBe(oldClient)
  await act(async () => controller.retryPRSidebar())
  await settleDetails('replacement')
  await act(async () => oldEnsure.resolve(rpcSuccess('old-ensure', details('ensure-old'))))
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'replacement body' } }
  })

  await act(async () => {
    void controller.retryPRSidebar()
  })
  const oldGeneration = pendingDetails.shift()!
  generation += 1
  await act(async () => client.pushState('connected'))
  await update()
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'replacement body' } }
  })
  await act(async () =>
    oldGeneration.resolve(
      rpcSuccess('late-generation', { ...details('replacement'), body: 'late body' })
    )
  )
  expect(controller!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'replacement body' } }
  })
  await settleDetails('replacement')
  expect(layouts).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden', 'hidden', 'ready'])
})

it('retires details on accepted chip-only resource departure and none, retaining same-resource details across HEAD refresh', async () => {
  const client = createFakeRpcClient()
  let resource: string | null = 'a'
  let headSha = 'head-1'
  const pending: ((reply: RpcResponse) => void)[] = []
  const methods: string[] = []
  client.sendRequest = async (method) => {
    methods.push(method)
    if (method === 'github.workItemDetails') {
      return new Promise((resolve) => pending.push(resolve))
    }
    const value =
      method === 'github.repoSlug'
        ? repo('a')
        : method === 'worktree.show'
          ? { worktree: { branch: 'feat' } }
          : method === 'hostedReview.forBranch'
            ? null
            : method === 'github.prForBranch'
              ? resource
                ? pr(resource)
                : null
              : method === 'github.prChecks'
                ? []
                : method === 'status.get'
                  ? {
                      runtimeId: 'a',
                      hostDescriptor: { installationId: 'a' },
                      capabilities: ['github.exact-work-item-target.v1']
                    }
                  : undefined
    if (value === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, value)
  }
  let controller: MobilePrSidebarController
  function Probe() {
    controller = useMobilePrSidebarController({
      client,
      connState: 'connected',
      worktreeId: 'clone::/wt',
      branch: 'feat',
      headSha
    })
    return null
  }
  await act(async () => {
    renderer = create(<Probe />)
  })
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  await act(async () => {
    void controller.ensurePrSidebarDetails()
  })
  const departedA = pending.shift()!
  resource = 'b'
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  resource = 'a'
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  await act(async () => departedA(rpcSuccess('departed-a', details('a'))))
  expect(controller!.prSidebarState).toMatchObject({ kind: 'ready', data: { details: null } })
  await act(async () => {
    void controller.ensurePrSidebarDetails()
  })
  expect(pending).toHaveLength(1)
  const beforeNone = pending.shift()!
  resource = null
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  expect(controller!.prSidebarState).toEqual({ kind: 'none' })
  resource = 'a'
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  await act(async () => beforeNone(rpcSuccess('before-none', details('a'))))
  expect(controller!.prSidebarState).toMatchObject({ kind: 'ready', data: { details: null } })

  await act(async () => {
    void controller.ensurePrSidebarDetails()
  })
  const sameResource = pending.shift()!
  await act(async () => controller.refetchPRSidebar({ includeDetails: false }))
  await act(async () => sameResource(rpcSuccess('same-resource', details('a'))))
  if (controller!.prSidebarState.kind !== 'ready') {
    throw new Error('expected ready')
  }
  const prior = controller!.prSidebarState.data.details
  expect(prior).toMatchObject({ body: 'a body' })
  headSha = 'head-2'
  const checksBefore = methods.filter((m) => m === 'github.prChecks').length
  await act(async () => renderer!.update(<Probe />))
  expect(methods.filter((m) => m === 'github.prChecks')).toHaveLength(checksBefore + 1)
  expect(
    controller!.prSidebarState.kind === 'ready' && controller!.prSidebarState.data.details
  ).toBe(prior)
  expect(pending).toHaveLength(1)
  await act(async () => pending.shift()!(rpcSuccess('head-details', details('a'))))
})

it('does not retire committed A for a discarded suspended B render or allow a queued old publication to select B', async () => {
  const client = createFakeRpcClient()
  const held: ((reply: RpcResponse) => void)[] = []
  client.sendRequest = async (method) => {
    if (method === 'github.workItemDetails') {
      return new Promise((resolve) => held.push(resolve))
    }
    const value =
      method === 'github.repoSlug'
        ? repo('a')
        : method === 'worktree.show'
          ? { worktree: { branch: 'a' } }
          : method === 'hostedReview.forBranch'
            ? null
            : method === 'github.prForBranch'
              ? pr('a')
              : method === 'github.prChecks'
                ? []
                : method === 'status.get'
                  ? {
                      runtimeId: 'a',
                      hostDescriptor: { installationId: 'a' },
                      capabilities: ['github.exact-work-item-target.v1']
                    }
                  : undefined
    if (value === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, value)
  }
  let committed: MobilePrSidebarController
  const suspend = new Promise<never>(() => {})
  function Probe({ branch, suspended = false }: { branch: string; suspended?: boolean }) {
    const controller = useMobilePrSidebarController({
      client,
      connState: 'connected',
      worktreeId: 'clone::/wt',
      branch,
      headSha: branch
    })
    useLayoutEffect(() => {
      committed = controller
    })
    if (suspended) {
      throw suspend
    }
    return null
  }
  const view = (branch: string, suspended = false) => (
    <Suspense fallback={null}>
      <Probe branch={branch} suspended={suspended} />
    </Suspense>
  )
  await act(async () => {
    renderer = create(view('a'))
  })
  await act(async () => committed.openPRSidebar())
  const a = held.shift()!
  await act(async () => {
    startTransition(() => renderer!.update(view('b', true)))
  })
  await act(async () => a(rpcSuccess('a-still-committed', details('a'))))
  expect(committed!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'a body' } }
  })
  await act(async () => renderer!.update(view('a')))
  expect(committed!.prSidebarState).toMatchObject({
    kind: 'ready',
    data: { details: { body: 'a body' } }
  })
  await act(async () => {
    void committed.retryPRSidebar()
  })
  const queued = held.shift()!
  await act(async () => {
    queued(rpcSuccess('queued-a', details('a')))
    renderer!.update(view('b'))
  })
  expect(committed!.prSidebarState).toEqual({ kind: 'hidden' })
})
