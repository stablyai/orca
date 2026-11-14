import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { markRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { NewWorktreeModalProps } from '../../new-workspace/creation/forms/new-worktree-modal-types'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import { isFolderRepoCreateBusy, type FolderRepoTarget } from './folder-repo-worktree-create'
import { useFolderCreateFlow, type FolderCreateRepo } from './use-folder-create-flow'

const seen = vi.hoisted(() => {
  const state: {
    composer: NewWorktreeModalProps | null
    confirm: { visible: boolean; onConfirm?: () => void; onCancel: () => void } | null
    toasts: string[]
    haptics: number
  } = { composer: null, confirm: null, toasts: [], haptics: 0 }
  return state
})
vi.mock('react-native', () => ({ AppState: {} }))
vi.mock('../../new-workspace/creation/modal/NewWorktreeModalController', () => ({
  NewWorktreeModalController: (props: NewWorktreeModalProps) => {
    seen.composer = props
    return null
  }
}))
vi.mock('../../components/ConfirmModal', () => ({
  ConfirmModal: (props: { visible: boolean; onConfirm?: () => void; onCancel: () => void }) => {
    seen.confirm = props
    return null
  }
}))
vi.mock('../../components/TransientToast', () => ({
  TransientToast: () => null,
  useTransientToast: () => ({
    message: null,
    showToast: (text: string) => seen.toasts.push(text)
  })
}))
vi.mock('../../platform/haptics/haptics', () => ({
  triggerSuccess: () => (seen.haptics += 1),
  triggerError: () => (seen.haptics += 1)
}))
vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink: () => {} }))
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'connected' })
}))
vi.mock('../../new-workspace/creation/worktree-create-capability', () => ({
  readNewWorktreeRuntimeCapabilities: async () => ({ worktreeCreateIdempotency: false })
}))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

const FOLDER = 'folder:f-1'
const TAKEN = 'Branch payments already exists\nworktree_create_exact_name_taken'
const CREATED: RpcResponse = {
  id: '1',
  ok: true,
  result: { worktree: { id: 'repo::/w/payments', displayName: 'payments' } },
  _meta: { runtimeId: 'r' }
}

let repoCount = 0
function repoIn(): { repo: FolderCreateRepo; target: FolderRepoTarget } {
  repoCount += 1
  const repoId = `flow-repo-${repoCount}`
  return {
    repo: { id: repoId, displayName: repoId },
    target: { hostId: 'host-1', executionHost: undefined, folderWorktreeId: FOLDER, repoId }
  }
}

function replying(reply: RpcResponse) {
  const client = new FakeSession('connected')
  let answer: () => void = () => {}
  client.sendRequest.mockReturnValue(
    new Promise<RpcResponse>((resolve) => (answer = () => resolve(reply)))
  )
  return { client, answer: () => answer() }
}

type Flow = ReturnType<typeof useFolderCreateFlow>
let renderer: ReactTestRenderer | null = null

function mountFlow(refetch: () => void) {
  const flow: { current: Flow | null } = { current: null }
  let members: FolderListRow[] = []
  function Harness() {
    flow.current = useFolderCreateFlow({
      hostId: 'host-1',
      folderWorktreeId: FOLDER,
      executionHost: undefined,
      desktopCapabilities: [],
      members,
      observing: true,
      refetch,
      bottomInset: 0
    })
    return createElement(Fragment, null, flow.current.composerElement)
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return {
    flow,
    rerender: (next: FolderListRow[]) => {
      members = next
      act(() => renderer?.update(createElement(Harness)))
    }
  }
}

const composer = (): NewWorktreeModalProps => {
  if (!seen.composer) {
    throw new Error('the composer never rendered')
  }
  return seen.composer
}

afterEach(() => {
  vi.useRealTimers()
  act(() => renderer?.unmount())
  renderer = null
  seen.composer = null
  seen.confirm = null
  seen.toasts = []
  seen.haptics = 0
})

describe('useFolderCreateFlow', () => {
  it("keeps an open form when another repository's create lands", async () => {
    const { flow, rerender } = mountFlow(() => {})
    const b = repoIn()
    const refusal = replying({ id: '1', ok: false, error: { code: 'x', message: TAKEN } })
    const opening = flow.current!.onCreate(b.repo, b.target, refusal.client, 'payments')
    refusal.answer()
    await act(() => opening)
    expect(composer().folderLaunch?.repoId).toBe(b.target.repoId)

    const a = repoIn()
    const creating = replying(CREATED)
    const created = flow.current!.onCreate(a.repo, a.target, creating.client, 'payments')
    creating.answer()
    await act(() => created)
    rerender([
      {
        worktreeId: 'a-child',
        repoId: a.target.repoId,
        repo: 'a',
        displayName: 'payments',
        branch: 'payments'
      }
    ])

    expect(composer().visible).toBe(true)
    expect(composer().folderLaunch?.repoId).toBe(b.target.repoId)
  })

  async function openComposer(flow: { current: Flow | null }, repo = repoIn()) {
    const refusal = replying({ id: '1', ok: false, error: { code: 'x', message: TAKEN } })
    const opening = flow.current!.onCreate(repo.repo, repo.target, refusal.client, 'payments')
    refusal.answer()
    await act(() => opening)
    return composer()
  }

  it('gives the repository back when the screen is left with an unsent form', async () => {
    const { flow } = mountFlow(() => {})
    const repo = repoIn()
    await openComposer(flow, repo)
    expect(isFolderRepoCreateBusy(repo.target)).toBe(true)

    act(() => renderer?.unmount())
    renderer = null
    expect(isFolderRepoCreateBusy(repo.target)).toBe(false)
  })
  it('resends an unconfirmed create without setup once the user agrees', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { flow } = mountFlow(() => {})
    const a = repoIn()
    const lost = new FakeSession('connected')
    lost.sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('connection lost')))
    await act(() => flow.current!.onCreate(a.repo, a.target, lost, 'payments'))
    vi.advanceTimersByTime(60_000)

    const retry = new FakeSession('connected')
    retry.sendRequest
      .mockResolvedValueOnce({
        id: '1',
        ok: false,
        error: { code: 'x', message: 'Setup decision required for this repository' }
      })
      .mockResolvedValueOnce(CREATED)
    await act(() => flow.current!.onCreate(a.repo, a.target, retry, 'payments'))
    expect(seen.confirm?.visible).toBe(true)

    await act(async () => seen.confirm?.onConfirm?.())
    expect(retry.sendRequest.mock.calls[1]?.[1]).toMatchObject({
      name: 'payments',
      branchIntent: 'create-exact',
      setupDecision: 'skip'
    })
  })
  async function setupRefusedRetry(flow: { current: Flow | null }) {
    const a = repoIn()
    const lost = new FakeSession('connected')
    lost.sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('connection lost')))
    await act(() => flow.current!.onCreate(a.repo, a.target, lost, 'payments'))
    vi.advanceTimersByTime(60_000)
    const retry = replying({
      id: '1',
      ok: false,
      error: { code: 'x', message: 'Setup decision required for this repository' }
    })
    return { a, pending: flow.current!.onCreate(a.repo, a.target, retry.client, 'payments'), retry }
  }

  it("doesn't open a composer over a setup choice, and covers the list while it is open", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { flow } = mountFlow(() => {})
    const { pending, retry } = await setupRefusedRetry(flow)
    retry.answer()
    await act(() => pending)
    expect(seen.confirm?.visible).toBe(true)
    expect(flow.current!.covered).toBe(true)

    const b = repoIn()
    const refusal = replying({ id: '1', ok: false, error: { code: 'x', message: TAKEN } })
    const opening = flow.current!.onCreate(b.repo, b.target, refusal.client, 'payments')
    refusal.answer()
    await act(() => opening)
    expect(composer().visible).toBe(false)
    expect(isFolderRepoCreateBusy(b.target)).toBe(false)

    act(() => seen.confirm?.onCancel())
    expect(flow.current!.covered).toBe(false)
  })
})
