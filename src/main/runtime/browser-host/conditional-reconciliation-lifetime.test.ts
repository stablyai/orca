import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../../shared/browser-client-host-protocol'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'
import type { BrowserHostPageReconciliationOptions } from './browser-host-page-reconciliation-orchestration'

let root: string
beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'orca-reconciliation-admission-'))
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}

async function fixture(kind: 'restore' | 'reclaim') {
  const { createBrowserHostLeaseState } = await import('./browser-host-lease-attachment')
  const { BrowserHostPagePlacementRegistry } = await import('./browser-host-page-placement')
  const { BrowserHostPageReconciliationOrchestrator } =
    await import('./browser-host-page-reconciliation-orchestration')
  const { tryAcquireConditionalWorktreeRemoval } =
    await import('../../ipc/conditional-worktree-removal-lease')
  const authority = { authorityRuntimeId: 'runtime', authorityEpoch: 'current' }
  const old: BrowserClientHostedPageInventory = {
    ...authority,
    authorityEpoch: 'previous',
    browserHostClientId: 'host',
    browserHostGeneration: 4,
    browserPageId: 'page',
    pageHostGeneration: 7,
    browserProfileId: 'default',
    executionHostKey: 'route',
    state: 'active'
  }
  const state = createBrowserHostLeaseState({
    ...authority,
    generation: 1,
    pageInventory: kind === 'reclaim' ? [old] : [],
    input: {
      browserHostClientId: 'host',
      connectionId: 'connection',
      pairedDeviceId: 'device',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1
    }
  })
  const ledger = state.commandLedger
  if (!ledger) {
    throw new Error('Expected negotiated ledger')
  }
  const events: BrowserClientHostCommandEvent[] = []
  ledger.attach((event) => events.push(event))
  state.executionHostGrants.grant('route')
  const placements = new BrowserHostPagePlacementRegistry(authority)
  const orchestrator = new BrowserHostPageReconciliationOrchestrator(authority, placements)
  const intent: BrowserHostRuntimePageIntent = {
    ...authority,
    browserHostClientId: 'host',
    browserHostGeneration: 1,
    browserPageId: 'page',
    pageHostGeneration: 8,
    browserProfileId: 'default',
    executionHostKey: 'route',
    workspaceId: `repo::${root}`,
    ...(kind === 'reclaim' ? { reclaimFrom: { ...old, pairedDeviceId: 'device' } } : {})
  }
  const start = (options: BrowserHostPageReconciliationOptions = {}) =>
    orchestrator.adopt(state, [intent], options).catch((error: unknown) => error)
  const settle = (result: BrowserClientHostCommandResult) => {
    const event = events[0]
    if (!event) {
      throw new Error('Expected dispatched action')
    }
    return ledger.settle({ ...event, result })
  }
  const assertIdle = () => {
    const lease = tryAcquireConditionalWorktreeRemoval(root)
    expect(lease.kind).toBe('acquired')
    if (lease.kind === 'acquired') {
      lease.release()
    }
  }
  return {
    state,
    ledger,
    events,
    placements,
    start,
    settle,
    assertIdle,
    busy: () => tryAcquireConditionalWorktreeRemoval(root),
    fence: () => {
      orchestrator.fence(state)
      ledger.close()
    }
  }
}

it.each(['restore', 'reclaim'] as const)(
  'releases %s after exact completion and local commit',
  async (kind) => {
    const f = await fixture(kind)
    const pending = f.start()
    await flush()
    expect(f.events[0]?.command.type).toBe(kind === 'restore' ? 'restorePage' : 'reclaimPage')
    expect(f.busy()).toEqual({ kind: 'busy' })
    expect(f.settle({ status: 'completed' })).toBe(true)
    await pending
    expect(f.placements.getPlacement('page')).toMatchObject({
      kind: 'client',
      pageHostGeneration: 8
    })
    f.assertIdle()
  }
)

it.each(['restore', 'reclaim'] as const)(
  'keeps timed-out %s busy past 45 seconds and a late ack',
  async (kind) => {
    const f = await fixture(kind)
    const pending = f.start({ actionTimeoutMs: 10 })
    await flush()
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toBeInstanceOf(AggregateError)
    expect(f.placements.getPlacement('page')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(45001)
    expect(f.busy()).toEqual({ kind: 'busy' })
    expect(f.settle({ status: 'completed' })).toBe(true)
    await flush()
    expect(f.placements.getPlacement('page')).toBeUndefined()
    expect(f.busy()).toEqual({ kind: 'busy' })
  }
)

it.each(['restore', 'reclaim'] as const)(
  'keeps aborted %s busy after reservation cancellation',
  async (kind) => {
    const f = await fixture(kind)
    const controller = new AbortController()
    const pending = f.start({ signal: controller.signal })
    await flush()
    controller.abort(new Error('caller abort'))
    expect(await pending).toBeInstanceOf(AggregateError)
    expect(f.placements.getPlacement('page')).toBeUndefined()
    f.settle({ status: 'completed' })
    await flush()
    expect(f.busy()).toEqual({ kind: 'busy' })
  }
)

it.each(['restore', 'reclaim'] as const)(
  'retains %s when its lease fence rejects the raw result',
  async (kind) => {
    const f = await fixture(kind)
    const pending = f.start()
    await flush()
    f.fence()
    expect(await pending).toBeInstanceOf(AggregateError)
    expect(f.busy()).toEqual({ kind: 'busy' })
  }
)

it.each(['restore', 'reclaim'] as const)('retains %s with unverified cleanup', async (kind) => {
  const f = await fixture(kind)
  const pending = f.start()
  await flush()
  f.settle({ status: 'failed', errorCode: 'browser_client_page_cleanup_failed' })
  expect(await pending).toBeInstanceOf(AggregateError)
  expect(f.busy()).toEqual({ kind: 'busy' })
})

it.each(['browser_client_page_executor_closed', 'browser_client_page_command_invalid'])(
  'releases a definitive no-effect response %s',
  async (errorCode) => {
    const f = await fixture('restore')
    const pending = f.start()
    await flush()
    f.settle({ status: 'failed', errorCode })
    expect(await pending).toBeInstanceOf(AggregateError)
    f.assertIdle()
  }
)

it('releases a ledger validation failure before any dispatch', async () => {
  const f = await fixture('restore')
  f.ledger.close()
  expect(await f.start()).toBeInstanceOf(AggregateError)
  expect(f.events).toEqual([])
  f.assertIdle()
})
