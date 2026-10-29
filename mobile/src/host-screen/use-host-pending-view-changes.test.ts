import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

import {
  SetCollapsedParams,
  type SetCollapsedRequest
} from '../../../src/shared/rpc-contract/workspace-view-collapse-params'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import {
  PENDING_VIEW_CHANGE_STALE_MS,
  addPendingViewChange,
  reconcilePendingViewChanges,
  withPendingViewChanges,
  type PendingViewChange
} from './host-view-pending-changes'
import {
  useSwitchedHostPendingViewChanges,
  type HostPendingViewChanges,
  type PendingViewOutcome
} from './use-host-pending-view-changes'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

function ok(): RpcResponse {
  return {
    id: 'r',
    ok: true,
    result: { collapsed: true, applied: true },
    _meta: { runtimeId: 'x' }
  }
}

function refused(code: string): RpcResponse {
  return { id: 'r', ok: false, error: { code, message: code }, _meta: { runtimeId: 'x' } }
}

function mount(sendRequest: (method: string, params: unknown) => Promise<RpcResponse>) {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation((method, params) => sendRequest(method, params))
  const send = client.sendRequest
  let changes: HostPendingViewChanges | null = null
  function Probe(): null {
    changes = useSwitchedHostPendingViewChanges(client)
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  return { client, send, current: () => changes! }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  unmountRenderers()
  vi.useRealTimers()
})

describe('the phone’s own option changes', () => {
  it('show as pending until the desktop acknowledges them', async () => {
    let answer: ((reply: RpcResponse) => void) | undefined
    const screen = mount(() => new Promise((resolve) => (answer = resolve)))
    let outcome: Promise<PendingViewOutcome> | null = null
    act(() => {
      outcome = screen.current().controls.sendView({ groupBy: 'none' }, { groupBy: 'none' })
    })
    expect(screen.current().status.pending).toHaveLength(1)
    if (answer === undefined) {
      throw new Error('view write never started')
    }
    answer(ok())
    await flush()
    expect(await outcome).toBe('settled')
    expect(screen.current().status.pending).toEqual([])
  })

  it('drop a refused change and say it was refused', async () => {
    const screen = mount(async () => refused('invalid_params'))
    let outcome: Promise<PendingViewOutcome> | null = null
    act(() => {
      outcome = screen.current().controls.sendView({ groupBy: 'none' }, { groupBy: 'none' })
    })
    await flush()
    expect(await outcome).toBe('refused')
    expect(screen.current().status.pending).toEqual([])
  })

  it('stay quiet about a refusal of a change a later one replaced', async () => {
    const answers: ((reply: RpcResponse) => void)[] = []
    const screen = mount(() => new Promise((resolve) => answers.push(resolve)))
    let first: Promise<PendingViewOutcome> | null = null
    act(() => {
      first = screen.current().controls.sendView({ sortBy: 'name' }, { sortBy: 'name' })
    })
    act(() => void screen.current().controls.sendView({ sortBy: 'recent' }, { sortBy: 'recent' }))
    answers[0](refused('invalid_params'))
    await flush()
    expect(await first).toBe('waiting')
    expect(screen.current().status.pending).toHaveLength(1)
  })

  it('keep a change the desktop has not answered, saying so after ten seconds', () => {
    vi.useFakeTimers()
    const screen = mount(() => new Promise(() => {}))
    act(() => void screen.current().controls.sendView({ sortBy: 'name' }, { sortBy: 'name' }))
    expect(screen.current().status.stale).toBe(false)
    act(() => {
      vi.advanceTimersByTime(PENDING_VIEW_CHANGE_STALE_MS)
    })
    expect(screen.current().status.stale).toBe(true)
    expect(screen.current().status.pending).toHaveLength(1)
  })

  it('keep a change whose request dropped, and resend it after a reconnect', async () => {
    const screen = mount(async () => {
      throw new Error('client_disconnected')
    })
    act(() => void screen.current().controls.sendView({ sortBy: 'name' }, { sortBy: 'name' }))
    await flush()
    expect(screen.current().status.pending).toHaveLength(1)
    const sentByOpId = screen.current().controls.lastOpId()
    act(() => {
      screen.current().controls.reconcile({ sortBy: 'recent' }, { resend: true, sentByOpId })
    })
    expect(screen.send.mock.calls).toEqual([
      ['ui.set', { sortBy: 'name' }],
      ['ui.set', { sortBy: 'name' }]
    ])
    act(() => {
      screen.current().controls.reconcile({ sortBy: 'name' }, { resend: false, sentByOpId })
    })
    expect(screen.current().status.pending).toEqual([])
  })

  it('report a host without ui.setCollapsed, which then takes the whole list', async () => {
    const screen = mount(async () => refused('method_not_found'))
    let outcome: Promise<PendingViewOutcome> | null = null
    act(() => {
      outcome = screen.current().controls.sendCollapse('repo:orca', true)
    })
    await flush()
    expect(await outcome).toBe('unavailable')
    expect(screen.current().status.pending).toEqual([])
  })

  it('send collapses under one writer with a growing seq', async () => {
    const sent: SetCollapsedRequest[] = []
    const screen = mount(async (_method, params) => {
      sent.push(SetCollapsedParams.parse(params))
      return ok()
    })
    act(() => void screen.current().controls.sendCollapse('a', true))
    act(() => void screen.current().controls.sendCollapse('a', false))
    await flush()
    expect(screen.send.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      { method: 'ui.setCollapsed', params: expect.objectContaining({ key: 'a', collapsed: true }) },
      { method: 'ui.setCollapsed', params: expect.objectContaining({ key: 'a', collapsed: false }) }
    ])
    const [first, second] = sent
    expect(second.opId.writer).toBe(first.opId.writer)
    expect(second.opId.seq).toBeGreaterThan(first.opId.seq)
  })

  it('keep the same controls while changes come and go', async () => {
    const screen = mount(async () => ok())
    const before = screen.current().controls
    act(() => void screen.current().controls.sendView({ sortBy: 'name' }, { sortBy: 'name' }))
    await flush()
    expect(screen.current().controls).toBe(before)
  })
})

describe('pending changes over the desktop’s values', () => {
  const collapse = (opId: number, collapsed: boolean): PendingViewChange => ({
    opId,
    sentAt: 0,
    kind: 'collapse',
    key: 'k',
    collapsed
  })

  it('lay the desired values over the view, oldest first', () => {
    const view = withPendingViewChanges(INITIAL_MOBILE_VIEW, [
      { opId: 1, sentAt: 0, kind: 'view', patch: { groupBy: 'none' }, payload: {} },
      collapse(2, true),
      { opId: 3, sentAt: 0, kind: 'view', patch: { groupBy: 'pr-status' }, payload: {} }
    ])
    expect(view.groupBy).toBe('pr-status')
    expect(view.collapsedGroups).toEqual(['k'])
  })

  it('keep only the latest intent for a section toggled twice', () => {
    const pending = addPendingViewChange([collapse(1, true)], collapse(2, false))
    expect(pending.map((change) => change.opId)).toEqual([2])
    expect(reconcilePendingViewChanges(pending, { collapsedGroups: [] }, 2)).toEqual([])
  })

  it('judge only changes sent before the read', () => {
    const pending = [collapse(3, true)]
    expect(reconcilePendingViewChanges(pending, { collapsedGroups: ['k'] }, 2)).toHaveLength(1)
    expect(reconcilePendingViewChanges(pending, { collapsedGroups: ['k'] }, 3)).toEqual([])
  })

  it('leave a value a later change also writes to that change', () => {
    const narrowed: PendingViewChange = {
      opId: 1,
      sentAt: 0,
      kind: 'view',
      patch: {},
      payload: { visibleWorkspaceHostIds: ['ssh:a'], workspaceHostScope: 'ssh:a' }
    }
    const widened: PendingViewChange = {
      opId: 2,
      sentAt: 0,
      kind: 'view',
      patch: {},
      payload: { visibleWorkspaceHostIds: ['ssh:a', 'local'] }
    }
    const pending = addPendingViewChange([narrowed], widened)
    expect(pending).toHaveLength(2)
    const waiting = reconcilePendingViewChanges(pending, { workspaceHostScope: 'ssh:a' }, 2)
    expect(waiting.map((change) => change.opId)).toEqual([2])
  })
})
