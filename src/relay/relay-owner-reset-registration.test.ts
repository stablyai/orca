import { expect, it, vi } from 'vitest'
import type { Server } from 'node:net'
import type { MethodHandler, RequestContext } from './dispatcher'
import { registerRelayOwnerReset } from './relay-owner-reset-registration'
import { parseRelayResetPreparationBinding } from '../shared/relay-reset-preparation-contract'
import {
  RELAY_OWNER_RESET_CAPABILITY,
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from '../shared/relay-owner-reset-contract'

function connection(clientId = 1) {
  let callback: Parameters<NonNullable<RequestContext['onResponseSettled']>>[0] | undefined
  const context: RequestContext = {
    clientId,
    transportGeneration: clientId,
    isStale: () => false,
    sessionIdentity: {
      principal: 'owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    },
    onResponseSettled: (settle) => {
      callback = settle
    }
  }
  return { context, settle: () => callback!({ ok: true }) }
}

function fixture(
  runtimeIncarnation?: string,
  persistPrepared?: Parameters<typeof registerRelayOwnerReset>[1]['persistPrepared'],
  describePreparation?: Parameters<typeof registerRelayOwnerReset>[1]['describePreparation']
) {
  const methods = new Map<string, MethodHandler>()
  const owner = { ownerGeneration: 1, ownerLease: 'lease' }
  const owners = {
    activeSessionOwner: vi.fn(() => owner as typeof owner | null),
    assertOwnerPublicationSettled: vi.fn()
  }
  const lifecycle = {
    prepareShutdown: vi.fn(async (_context?: RequestContext, admitted?: () => void) => {
      admitted?.()
    }),
    finishShutdown: vi.fn()
  }
  const server = { listening: true }
  const socket = {
    server: server as Server | null,
    ownsCurrentPath: vi.fn(() => true)
  }
  const status = registerRelayOwnerReset(
    { onRequest: (name, handler) => methods.set(name, handler) },
    { owners, lifecycle, socket, runtimeIncarnation, persistPrepared, describePreparation }
  )
  const params = {
    version: 1,
    operationId: 'reset-1',
    runtimeIncarnation: status().ownerReset!.runtimeIncarnation,
    ...owner
  }
  const call = (method: string, context: RequestContext) => methods.get(method)!(params, context)
  return { methods, owners, lifecycle, server, socket, status, params, call }
}

it('publishes coordinates bound to the requesting authenticated owner only', () => {
  const describe = vi.fn((principal: string, authenticationKind: string) =>
    parseRelayResetPreparationBinding({
      version: 1,
      journalDirectory: '/journal',
      sockPath: '/socket',
      serverBuildId: 'build',
      principal,
      authenticationKind
    })
  )
  const f = fixture(undefined, () => undefined, describe)
  const { context } = connection()
  expect(f.status(context).ownerReset?.preparation).toMatchObject({
    principal: 'owner',
    journalDirectory: '/journal'
  })
  expect(f.status().ownerReset?.preparation).toBeUndefined()
  expect(f.status({ ...context, isStale: () => true }).ownerReset?.preparation).toBeUndefined()
  expect(
    f.status({ ...context, sessionIdentity: undefined }).ownerReset?.preparation
  ).toBeUndefined()
  describe.mockClear()
  f.server.listening = false
  expect(f.status(context)).toEqual({ capabilities: [] })
  expect(describe).not.toHaveBeenCalled()
})

it('advertises durable preparation only when the journal writer is installed', () => {
  expect(fixture().status().capabilities).not.toContain(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  const f = fixture(undefined, () => undefined)
  expect(f.status().capabilities).toContain(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  f.server.listening = false
  expect(f.status().capabilities).not.toContain(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
})

it('registers both operations before advertising a stable incarnation', () => {
  const f = fixture()
  expect([...f.methods.keys()]).toEqual([
    RELAY_OWNER_RESET_METHOD,
    RELAY_PREPARED_RESET_RECOVERY_METHOD
  ])
  expect(f.status()).toEqual({
    capabilities: [RELAY_OWNER_RESET_CAPABILITY],
    ownerReset: { version: 1, runtimeIncarnation: expect.any(String) }
  })
  expect(f.status()).toEqual(f.status())
  expect(f.params.runtimeIncarnation).not.toBe('')
})

it('uses the daemon incarnation shared with network tunnel ownership', () => {
  const f = fixture('shared-daemon-incarnation')
  expect(f.status().ownerReset?.runtimeIncarnation).toBe('shared-daemon-incarnation')
})

it.each(['missing-server', 'not-listening', 'lost-path'])(
  'withdraws capability and refuses initial reset on %s',
  async (failure) => {
    const f = fixture()
    if (failure === 'missing-server') {
      f.socket.server = null
    } else if (failure === 'not-listening') {
      f.server.listening = false
    } else {
      f.socket.ownsCurrentPath.mockReturnValue(false)
    }
    expect(f.status()).toEqual({ capabilities: [] })
    await expect(f.call(RELAY_OWNER_RESET_METHOD, connection().context)).rejects.toThrow()
    expect(f.lifecycle.prepareShutdown).not.toHaveBeenCalled()
    expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  }
)

it('reuses the same incarnation and prepared result across authenticated reconnect', async () => {
  const f = fixture()
  const result = await f.call(RELAY_OWNER_RESET_METHOD, connection().context)
  f.owners.activeSessionOwner.mockReturnValue(null)
  const recovered = connection(2)
  await expect(f.call(RELAY_PREPARED_RESET_RECOVERY_METHOD, recovered.context)).resolves.toEqual(
    result
  )
  expect(f.status().ownerReset!.runtimeIncarnation).toBe(f.params.runtimeIncarnation)
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(1)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  recovered.settle()
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledTimes(1)
})

it.each(['initial', 'recovery'] as const)(
  'refuses %s settlement after endpoint ownership disappears',
  async (mode) => {
    const f = fixture()
    const initial = connection()
    await f.call(RELAY_OWNER_RESET_METHOD, initial.context)
    const response = mode === 'initial' ? initial : connection(2)
    if (mode === 'recovery') {
      await f.call(RELAY_PREPARED_RESET_RECOVERY_METHOD, response.context)
    }
    f.socket.ownsCurrentPath.mockReturnValue(false)
    expect(() => response.settle()).toThrow()
    expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
    expect(f.status()).toEqual({ capabilities: [] })
  }
)

it('refuses prepared recovery when endpoint stops listening and allows exact retry after restoration', async () => {
  const f = fixture()
  await f.call(RELAY_OWNER_RESET_METHOD, connection().context)
  f.server.listening = false
  await expect(
    f.call(RELAY_PREPARED_RESET_RECOVERY_METHOD, connection(2).context)
  ).rejects.toThrow()
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  f.server.listening = true
  const retry = connection(3)
  await f.call(RELAY_PREPARED_RESET_RECOVERY_METHOD, retry.context)
  retry.settle()
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(1)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledTimes(1)
})
