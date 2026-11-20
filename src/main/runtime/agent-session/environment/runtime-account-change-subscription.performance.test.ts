import { beforeEach, expect, it, vi } from 'vitest'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'
import { subscribeRuntimeAccountChanges } from './runtime-account-change-subscription'

const data = vi.hoisted(() => ({ enabled: false, listeners: new Set<() => void>() }))
vi.mock('../../../../shared/app-lifecycle/app-environment', () => ({
  hasAppEnvironment: () => data.enabled
}))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    onChanged: (fn: () => void) => {
      data.listeners.add(fn)
      return () => data.listeners.delete(fn)
    }
  })
}))
beforeEach(() => {
  data.enabled = false
  data.listeners.clear()
})

function harness() {
  const listeners = new Set<(state: AccountsSnapshot['rateLimits']) => void>()
  const renamed = new Set<() => void>()
  const generations: [number, number] = [0, 0]
  const accounts = { accounts: [], activeAccountId: null }
  const codex = vi.fn<() => Promise<AccountsSnapshot['codex']>>(async () => accounts)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these service seams are used by subscriptions.
  const services = {
    claudeAccounts: {
      listAccounts: () => accounts,
      onAccountRenamed: (fn: () => void) => {
        renamed.add(fn)
        return () => renamed.delete(fn)
      }
    },
    codexAccounts: { listAccounts: codex, onAccountRenamed: () => () => {} },
    rateLimits: {
      getAccountRefreshGenerations: () => [...generations],
      onStateChange: (fn: (state: AccountsSnapshot['rateLimits']) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    }
  } as unknown as RuntimeAccountServices
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: usage is an opaque producer snapshot at this seam.
  const usage = { codex: { session: { usedPercent: 12 } } } as AccountsSnapshot['rateLimits']
  const snapshot = { claude: accounts, codex: accounts, rateLimits: usage }
  const stream = vi.fn(async () => snapshot)
  const snapshots = { stream, dataAccounts: () => ({}) }
  const emit = (value = usage) => listeners.forEach((fn) => fn(value))
  return { services, listeners, renamed, codex, usage, snapshot, snapshots, emit, generations }
}

it('reuses published usage across concurrent subscribers', async () => {
  const count = 100
  const h = harness()
  const received: AccountsSnapshot[] = []
  const stops = Array.from({ length: count }, () =>
    subscribeRuntimeAccountChanges(h.services, h.snapshots, (snapshot) => received.push(snapshot))
  )
  h.emit()
  await Promise.resolve()
  expect(received).toHaveLength(count)
  expect(received.every((snapshot) => snapshot.rateLimits === h.usage)).toBe(true)
  expect(h.snapshots.stream).not.toHaveBeenCalled()
  stops.forEach((stop) => stop())
  expect(h.listeners.size).toBe(0)
})

it('admits only the newest pending publication and releases it on disconnect', async () => {
  const h = harness()
  const blocked = Promise.withResolvers<AccountsSnapshot['codex']>()
  h.codex.mockReturnValue(blocked.promise)
  const listener = vi.fn()
  const stop = subscribeRuntimeAccountChanges(h.services, h.snapshots, listener)
  for (let i = 0; i < 100; i++) {
    h.emit()
  }
  expect(h.codex).toHaveBeenCalledTimes(1)
  stop()
  blocked.resolve(h.snapshot.codex)
  await Promise.resolve()
  expect(listener).not.toHaveBeenCalled()
  expect(h.codex).toHaveBeenCalledTimes(1)
})

it.each(['rename', 'data'] as const)(
  'invalidates in-flight usage on %s changes even when another usage update follows',
  async (source) => {
    const h = harness()
    data.enabled = true
    const blocked = Promise.withResolvers<AccountsSnapshot['codex']>()
    h.codex.mockReturnValueOnce(blocked.promise)
    const received: AccountsSnapshot[] = []
    const delivered = Promise.withResolvers<void>()
    const stop = subscribeRuntimeAccountChanges(h.services, h.snapshots, (snapshot) => {
      received.push(snapshot)
      delivered.resolve()
    })
    h.emit()
    const events = source === 'rename' ? h.renamed : data.listeners
    events.forEach((fn) => fn())
    h.emit()
    blocked.resolve(h.snapshot.codex)
    await delivered.promise
    expect(received).toHaveLength(1)
    expect(received[0].rateLimits).toBe(h.usage)
    stop()
    expect(data.listeners.size).toBe(0)
  }
)

it.each([0, 1])(
  'invalidates active and pending usage on provider %i account switches',
  async (provider) => {
    const h = harness()
    const blocked = Promise.withResolvers<AccountsSnapshot['codex']>()
    const pending = Promise.withResolvers<AccountsSnapshot['codex']>()
    const entered = Promise.withResolvers<void>()
    h.codex.mockReturnValueOnce(blocked.promise).mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    const received: AccountsSnapshot[] = []
    const delivered = Promise.withResolvers<void>()
    const stop = subscribeRuntimeAccountChanges(h.services, h.snapshots, (snapshot) => {
      received.push(snapshot)
      delivered.resolve()
    })
    h.emit()
    h.emit()
    h.generations[provider]++
    blocked.resolve(h.snapshot.codex)
    await entered.promise
    const nextUsage = { ...h.usage, codex: null }
    h.emit(nextUsage)
    pending.resolve(h.snapshot.codex)
    await delivered.promise
    expect(received).toHaveLength(1)
    expect(received[0].rateLimits).toBe(nextUsage)
    stop()
  }
)

it('delivers account snapshots throughout overlapping usage changes', async () => {
  const count = 100
  const h = harness()
  const reads = Array.from({ length: count + 2 }, () => ({
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<AccountsSnapshot['codex']>()
  }))
  let nextRead = 0
  h.codex.mockImplementation(() => {
    const read = reads[nextRead++]
    read.entered.resolve()
    return read.release.promise
  })
  const usage = (value: number): AccountsSnapshot['rateLimits'] => ({
    ...h.usage,
    codex: {
      provider: 'codex',
      status: 'ok',
      error: null,
      updatedAt: value,
      weekly: null,
      session: { usedPercent: value, windowMinutes: 300, resetsAt: null, resetDescription: null }
    }
  })
  const received: AccountsSnapshot[] = []
  const latest = Promise.withResolvers<void>()
  const stop = subscribeRuntimeAccountChanges(h.services, h.snapshots, (snapshot) => {
    received.push(snapshot)
    if (received.length === count + 1) {
      latest.resolve()
    }
  })
  h.emit(usage(0))
  await reads[0].entered.promise
  for (let value = 1; value <= count; value++) {
    h.emit(usage(value))
    reads[value - 1].release.resolve(h.snapshot.codex)
    await reads[value].entered.promise
    expect(received).toHaveLength(value)
    expect(received[value - 1].rateLimits.codex?.session?.usedPercent).toBe(value - 1)
  }
  reads[count].release.resolve(h.snapshot.codex)
  await latest.promise
  expect(received).toHaveLength(count + 1)
  expect(received[count].rateLimits.codex?.session?.usedPercent).toBe(count)
  h.emit(usage(count + 1))
  await reads[count + 1].entered.promise
  h.emit(usage(count + 2))
  stop()
  reads[count + 1].release.resolve(h.snapshot.codex)
  await reads[count + 1].release.promise
  h.emit(usage(count + 3))
  expect(received).toHaveLength(count + 1)
  expect(h.listeners.size).toBe(0)
  expect(h.renamed.size).toBe(0)
})
