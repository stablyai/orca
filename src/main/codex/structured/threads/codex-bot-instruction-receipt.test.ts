import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { recordStartedHandle } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-provider-answer'
import { releaseStoredAgentSessionOwnerAfterSurfaceClose } from '../../../runtime/agent-session/ownership/agent-session-surface-release-transition'
import {
  install,
  NOW,
  SNAPSHOT,
  store,
  reopenInstallationStore,
  seedInstallationRecord,
  recordInstallation,
  openedContext
} from './codex-bot-instruction-installation.test-support'

it('commits a fresh delivery with its actual handle and reuses it after a store reopen', async () => {
  await recordInstallation(true)
  await reopenInstallationStore()
  expect(store.getRecord('release-chat')?.instructionPolicy).toMatchObject({
    state: 'delivered',
    anchor: 'anchor-1',
    nativeId: 'native-release'
  })
  const request = vi.fn<CodexAppServerConnection['request']>(async () => ({}))
  const result = await install(request)
  expect(result.filesIncluded).toBe(false)
  expect(request.mock.calls).toEqual([])
})

it('anchors resumed delivery to the handle the store retains and deduplicates after reopening', async () => {
  await recordInstallation()
  await reopenInstallationStore()
  expect(store.getRecord('release-chat')?.instructionPolicy).toMatchObject({
    state: 'delivered',
    anchor: 'seed-anchor'
  })
  expect((await install()).filesIncluded).toBe(false)
})

it('repairs a matching receipt when outside-history continuity is unknown', async () => {
  const old = await recordInstallation(true)
  const next = await install(undefined, undefined, false, { historyUnchanged: false })
  expect(next.filesIncluded).toBe(true)
  expect(next.policy.operationId).not.toBe(old.instructionPolicy.operationId)
})

it.each(['botId', 'standing', 'snapshot', 'generation', 'anchor', 'nativeId', 'fence'] as const)(
  'refuses a provider receipt with a different %s and keeps the committed receipt',
  async (field) => {
    const event = await recordInstallation(true)
    const original = store.getRecord('release-chat')!.instructionPolicy
    expect(
      await recordStartedHandle(openedContext(), {
        ...event,
        instructionPolicy: {
          ...event.instructionPolicy,
          [field]: field === 'fence' ? 999 : 'different'
        }
      })
    ).toBe(false)
    await reopenInstallationStore()
    expect(store.getRecord('release-chat')!.instructionPolicy).toEqual(original)
  }
)

it.each(['folder', 'host', 'wsl', 'adoption'] as const)(
  'invalidates a delivered receipt after %s changes',
  async (change) => {
    await recordInstallation()
    await seedInstallationRecord((record) =>
      change === 'adoption'
        ? {
            ...record,
            providerHandleChain: record.providerHandleChain.map((link) => ({
              ...link,
              linkId: 'adopted-link'
            }))
          }
        : {
            ...record,
            location: {
              ...record.location,
              ...(change === 'folder'
                ? { workspaceId: 'folder:other' }
                : change === 'host'
                  ? { executionHostId: 'ssh:probe' as const }
                  : { wslDistro: 'Ubuntu' })
            }
          }
    )
    const request = vi.fn<CodexAppServerConnection['request']>(async () => ({}))
    const result = await install(request)
    expect(result.filesIncluded).toBe(true)
    expect(request.mock.calls[0]?.[0]).toBe('thread/inject_items')
  }
)

it('rejects a late receipt after replacement context and preserves the pending newer operation', async () => {
  const { policy } = await install()
  await seedInstallationRecord((record) => ({
    ...record,
    instructionPolicy: { ...policy, operationId: 'newer-operation', state: 'pending' }
  }))
  expect(
    await recordStartedHandle(openedContext(), {
      sessionId: 'release-chat',
      fence: policy.fence,
      acquisitionGeneration: 'generation-1',
      link: {
        linkId: 'anchor-1',
        handle: codexProviderHandle('native-release'),
        origin: 'resumed',
        mintedAtFence: policy.fence,
        observedAt: NOW
      },
      reportedOptions: {},
      instructionPolicy: policy,
      instructionContext: {
        account: '/isolated/codex',
        digest: SNAPSHOT.digest,
        filesIncluded: true
      }
    })
  ).toBe(false)
  await reopenInstallationStore()
  expect(store.getRecord('release-chat')?.instructionPolicy).toMatchObject({
    operationId: 'newer-operation',
    state: 'pending'
  })
  expect(store.getRecord('release-chat')?.providerHandleChain).toEqual([])
})

it('retains the released-writer proof across reopen and a new lease before repairing with a new operation', async () => {
  const fence = store.getRecord('release-chat')!.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: 'release-chat',
    fence,
    now: NOW,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-1' }
  })
  await store.proveOwner({ sessionId: 'release-chat', fence, now: NOW })
  await expect(
    install(
      vi.fn(async () => {
        throw new Error('reply lost after mutation')
      })
    )
  ).rejects.toMatchObject({ fact: { instructionRecovery: 'unknown' } })
  const a = store.getRecord('release-chat')!.instructionPolicy!.operationId
  await releaseStoredAgentSessionOwnerAfterSurfaceClose(store, {
    sessionId: 'release-chat',
    expectedFence: fence,
    now: NOW + 1
  })
  await reopenInstallationStore()
  expect(store.getRecord('release-chat')?.instructionPolicy).toMatchObject({
    operationId: a,
    state: 'released'
  })
  await store.reconcileOnRestart({
    sessionId: 'release-chat',
    probe: async () => ({ outcome: 'reservation-unused' }),
    now: NOW + 2
  })
  await store.reserveOwner({
    sessionId: 'release-chat',
    provider: 'codex',
    location: store.getRecord('release-chat')!.location,
    accountHome: { variable: 'CODEX_HOME', path: '/isolated/codex' },
    expectedFence: fence + 1,
    spawnToken: 'spawn-2',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'owner',
      operationId: `${NOW}-${'2'.repeat(32)}`,
      fingerprint: 'reserve-2'
    },
    now: NOW + 2
  })
  const { policy: b } = await install()
  expect(b.operationId).not.toBe(a)
  expect(b.fence).toBe(fence + 2)
})

it('repairs after a completed rewind survives a store reopen', async () => {
  const previous = await recordInstallation()
  await seedInstallationRecord((record) => ({
    ...record,
    rewind: {
      operationId: 'rewind-1',
      callerKey: 'owner',
      itemId: 'orca:owner-task',
      expectedEpoch: 'epoch-0',
      phase: 'completed',
      epoch: 'epoch-1'
    }
  }))
  await reopenInstallationStore()
  const { policy, filesIncluded } = await install()
  expect(filesIncluded).toBe(true)
  expect(policy.scope).not.toBe(previous.instructionPolicy.scope)
})

it('repairs after a durable clear boundary changes', async () => {
  const previous = await recordInstallation()
  await seedInstallationRecord((record) => ({
    ...record,
    providerContextBoundary: {
      operationId: 'clear-1',
      afterFence: record.lease.runtimeFence,
      clearedAt: NOW + 1
    }
  }))
  await reopenInstallationStore()
  const { policy, filesIncluded } = await install()
  expect(filesIncluded).toBe(true)
  expect(policy.scope).not.toBe(previous.instructionPolicy.scope)
})

it('reuses delivery when only a legacy rewind cache is retired', async () => {
  await seedInstallationRecord((record) => ({
    ...record,
    rewind: {
      operationId: 'rewind-1',
      callerKey: 'owner',
      itemId: 'orca:owner-task',
      expectedEpoch: 'epoch-0',
      phase: 'completed',
      epoch: 'epoch-1',
      retained: []
    }
  }))
  await recordInstallation()
  await seedInstallationRecord((record) => {
    const { retained: _retained, ...rewind } = record.rewind!
    return { ...record, rewind }
  })
  await reopenInstallationStore()
  expect((await install()).filesIncluded).toBe(false)
})

it('does not commit a dynamic baseline different from the proven launch snapshot', async () => {
  const event = await recordInstallation(true)
  const original = store.getRecord('release-chat')!.instructionPolicy
  expect(
    await recordStartedHandle(openedContext(), {
      ...event,
      instructionPolicy: {
        ...event.instructionPolicy,
        baseline: {
          ...SNAPSHOT.baseline,
          soul: 'c'.repeat(64)
        }
      }
    })
  ).toBe(false)
  await reopenInstallationStore()
  expect(store.getRecord('release-chat')!.instructionPolicy).toEqual(original)
})
