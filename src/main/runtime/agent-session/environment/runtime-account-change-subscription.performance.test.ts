import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'
import { subscribeRuntimeAccountChanges } from './runtime-account-change-subscription'

vi.mock('../../../../shared/app-lifecycle/app-environment', () => ({
  hasAppEnvironment: () => false
}))

function harness() {
  const listeners = new Set<(state: AccountsSnapshot['rateLimits']) => void>()
  const renamed = new Set<() => void>()
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
  const emit = () => listeners.forEach((fn) => fn(usage))
  return { services, listeners, renamed, codex, usage, snapshot, snapshots, emit }
}

it.each([1, 10, 100])('reuses published usage for %i subscribers', async (count) => {
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

it('rebuilds a data or rename snapshot after in-flight usage and keeps the latest update', async () => {
  const h = harness()
  const blocked = Promise.withResolvers<AccountsSnapshot['codex']>()
  h.codex.mockReturnValueOnce(blocked.promise)
  const listener = vi.fn()
  const stop = subscribeRuntimeAccountChanges(h.services, h.snapshots, listener)
  h.emit()
  h.renamed.forEach((fn) => fn())
  blocked.resolve(h.snapshot.codex)
  await Promise.resolve()
  await Promise.resolve()
  expect(listener).toHaveBeenCalledWith(h.snapshot)
  expect(h.snapshots.stream).toHaveBeenCalledTimes(1)
  stop()
})
