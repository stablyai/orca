import { createElement, startTransition, Suspense } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import * as diffLines from '../session/mobile-diff-lines'

vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() })
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSelection: vi.fn() }))

const entry = { path: 'src/app.ts', status: 'modified' } as const
const summary = {
  baseRef: 'main',
  headOid: 'head',
  mergeBase: 'base',
  status: 'ready',
  changedFiles: 1,
  commitsAhead: 1,
  errorMessage: undefined
} as const
const success: RpcResponse = {
  id: 'branch-diff',
  ok: true,
  result: { kind: 'text', originalContent: 'old', modifiedContent: 'new' }
}
const suspended = new Promise<void>(() => {})
const suspendedRender = vi.fn()
const buildDiff = vi.spyOn(diffLines, 'buildMobileDiffLines')

describe('committed diff preview ownership', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: ReturnType<typeof useMobileSourceControlOpeners> | null = null
  const replies: ((response: RpcResponse) => void)[] = []
  let client: ReturnType<typeof createStableLogicalRpcClient>
  beforeEach(() => {
    buildDiff.mockClear()
    const physical = createFakeRpcClient()
    physical.sendRequest = () => new Promise((resolve) => replies.push(resolve))
    client = createStableLogicalRpcClient(physical, 'relay')
  })
  function Probe({
    worktreeId = 'wt-1',
    suspend = false
  }: {
    worktreeId?: string
    suspend?: boolean
  }) {
    const openers = useMobileSourceControlOpeners({
      client,
      diffShowWhitespace: false,
      connState: 'connected',
      hostId: 'host-1',
      worktreeId,
      name: 'api',
      origin: 'session',
      embedded: true,
      branchCompareState: { kind: 'ready', result: { summary, entries: [entry] } },
      mountedRef: { current: true },
      busyActionRef: { current: null },
      setActionError: vi.fn()
    })
    if (suspend) {
      suspendedRender()
      throw suspended
    }
    latest = openers
    return null
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
    replies.length = 0
    client.close()
  })
  function mount() {
    act(() => {
      renderer = create(createElement(Probe))
    })
  }
  function open() {
    let pending: Promise<void> | undefined
    act(() => {
      pending = latest?.openBranchDiff(entry)
    })
    return pending
  }
  it.each(['success', 'refusal'])(
    'does not reopen a dismissed loading drawer when its %s arrives',
    async (outcome) => {
      mount()
      const pending = open()
      expect(latest?.branchDiffPreview?.kind).toBe('loading')
      act(() => latest?.setBranchDiffPreview(null))
      await act(async () => {
        replies[0]?.(
          outcome === 'success'
            ? success
            : {
                id: 'branch-diff',
                ok: false,
                error: { code: 'runtime_error', message: 'Read failed' }
              }
        )
        await pending
      })
      expect(latest?.branchDiffPreview).toBeNull()
    }
  )
  it('allows a new preview after dismissal and keeps it owned when the old reply arrives', async () => {
    mount()
    const old = open()
    act(() => latest?.setBranchDiffPreview(null))
    const current = open()
    expect(replies).toHaveLength(2)
    await act(async () => {
      replies[0]?.(success)
      await old
    })
    expect(latest?.branchDiffPreview?.kind).toBe('loading')
    expect(latest?.openingBranchPath).toBe(entry.path)
    expect(buildDiff).not.toHaveBeenCalled()
    await act(async () => {
      replies[1]?.(success)
      await current
    })
    expect(latest?.branchDiffPreview?.kind).toBe('ready')
    expect(buildDiff).toHaveBeenCalledTimes(1)
  })
  it('retires the preview when this mounted route changes workspace', async () => {
    mount()
    const pending = open()
    act(() => renderer?.update(createElement(Probe, { worktreeId: 'wt-2' })))
    expect(latest?.branchDiffPreview).toBeNull()
    await act(async () => {
      replies[0]?.(success)
      await pending
    })
    expect(latest?.branchDiffPreview).toBeNull()
  })

  it('keeps a confirmed preview across a connection-path change to the same computer', async () => {
    mount()
    const pending = open()
    await act(async () => {
      await client.migrateTo(createFakeRpcClient(), 'lan')
      renderer?.update(createElement(Probe))
    })
    expect(latest?.branchDiffPreview?.kind).toBe('loading')
    await act(async () => {
      replies[0]?.(success)
      await pending
    })
    expect(latest?.branchDiffPreview?.kind).toBe('ready')
    expect(latest?.openingBranchPath).toBeNull()
  })

  it('keeps the current preview when a workspace transition suspends before commit', async () => {
    const render = (suspend = false) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(Probe, {
          worktreeId: suspend ? 'wt-2' : 'wt-1',
          suspend
        })
      )
    act(() => {
      renderer = create(render())
    })
    const pending = open()
    suspendedRender.mockClear()
    act(() => {
      startTransition(() => renderer?.update(render(true)))
    })
    expect(suspendedRender).toHaveBeenCalled()
    await act(async () => {
      replies[0]?.(success)
      await pending
    })
    expect(latest?.branchDiffPreview?.kind).toBe('ready')
    expect(latest?.openingBranchPath).toBeNull()
  })
})
