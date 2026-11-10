import { expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { getSecretRequestStore } from '../../../secrets/secret-request-store'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from '../rpc-method-registry'

const methods = eraseRpcMethods(ALL_RPC_METHODS)
const subscribeMethod = methods
  .filter(isStreamingMethod)
  .find((method) => method.name === 'runtime.clientEvents.subscribe')

function makeRuntime(): { runtime: OrcaRuntimeService; cleanups: (() => void)[] } {
  const cleanups: (() => void)[] = []
  const fake = {
    getRuntimeId: () => 'runtime-a',
    onClientEvent: () => () => {},
    getClientSettings: () => ({ nativeChatQueueFollowUps: true }),
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      cleanups.push(cleanup)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscribe handler reads only these members.
  return { runtime: fake as unknown as OrcaRuntimeService, cleanups }
}

const secretEvents = (events: unknown[]): Record<string, unknown>[] =>
  events.filter(
    (event): event is Record<string, unknown> =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      typeof event.type === 'string' &&
      event.type.startsWith('secrets.')
  )

it('registers the secrets.* methods', () => {
  const names = methods.map((method) => method.name)
  for (const name of [
    'secrets.request',
    'secrets.requestStatus',
    'secrets.touchRequest',
    'secrets.resolveRequest'
  ]) {
    expect(names).toContain(name)
  }
})

it('replays pending secret requests on attach, streams new ones, and gives phones status only', async () => {
  if (!subscribeMethod) {
    throw new Error('runtime.clientEvents.subscribe is not a streaming method')
  }
  const store = getSecretRequestStore()
  // Made while no client was attached.
  const early = store.request({
    name: 'EARLY_SECRET',
    reason: 'needed before anyone attached',
    agent: 'claude',
    worktreeId: 'wt-1',
    terminalHandle: 'term-1',
    sessionEnvNames: new Set()
  })
  const { runtime, cleanups } = makeRuntime()
  const desktopCtx: RpcContext = { runtime, connectionId: 'conn-1', clientKind: 'runtime' }
  const phoneCtx: RpcContext = { runtime, connectionId: 'conn-2', clientKind: 'mobile' }
  const desktop: unknown[] = []
  const phone: unknown[] = []
  const done = [
    subscribeMethod.handler({}, desktopCtx, (event) => desktop.push(event)),
    subscribeMethod.handler({}, phoneCtx, (event) => phone.push(event))
  ]

  expect(secretEvents(desktop)).toEqual([
    expect.objectContaining({
      type: 'secrets.requested',
      requestId: early.requestId,
      reason: 'needed before anyone attached'
    })
  ])
  expect(secretEvents(phone)).toHaveLength(1)
  expect(secretEvents(phone)[0]).not.toHaveProperty('reason')

  const live = store.request({
    name: 'LIVE_SECRET',
    reason: 'asked while attached',
    agent: null,
    worktreeId: null,
    terminalHandle: null,
    sessionEnvNames: new Set()
  })
  if (!live.requestId) {
    throw new Error('expected a queued request')
  }
  store.resolve(live.requestId, 'declined')
  expect(secretEvents(desktop).map((event) => event.type)).toEqual([
    'secrets.requested',
    'secrets.requested',
    'secrets.requestSettled'
  ])

  cleanups.forEach((cleanup) => cleanup())
  await Promise.all(done)
  const before = desktop.length
  store.request({
    name: 'AFTER_CLOSE',
    reason: 'r',
    agent: null,
    worktreeId: null,
    terminalHandle: null,
    sessionEnvNames: new Set()
  })
  expect(desktop).toHaveLength(before)
})
