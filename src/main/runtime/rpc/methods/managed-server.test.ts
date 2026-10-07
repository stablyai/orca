import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  registerManagedServerActions,
  type ManagedServerActions
} from '../../managed-server-actions-registry'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { MANAGED_SERVER_METHODS } from './managed-server'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'managed-1', authToken: 'token', method, params }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read no runtime member; only the reply envelope needs getRuntimeId.
const RUNTIME = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService

function dispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime: RUNTIME, methods: MANAGED_SERVER_METHODS })
}

function actions(): ManagedServerActions {
  return {
    status: vi.fn(),
    update: vi.fn(async () => ({
      outcome: 'deferred' as const,
      candidateVersion: '2',
      code: 'c',
      reason: 'r'
    })),
    rollback: vi.fn(),
    recover: vi.fn(async () => ({ outcome: 'none' as const })),
    stop: vi.fn(async () => ({
      outcome: 'refused' as const,
      verdict: 'live' as const,
      code: 'c',
      reason: 'r'
    })),
    cancelStop: vi.fn()
  }
}

afterEach(() => registerManagedServerActions(null))

describe('managed server RPC', () => {
  it('refuses where no desktop runtime registered the actions', async () => {
    const response = await dispatcher().dispatch(
      request('managedServer.stop', { selector: 'build-box' })
    )
    expect(response).toMatchObject({ ok: false })
  })

  it('forwards to the same actions the settings run', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    await expect(
      dispatcher().dispatch(request('managedServer.stop', { selector: 'build-box' }))
    ).resolves.toMatchObject({ ok: true, result: { outcome: 'refused' } })
    expect(registered.stop).toHaveBeenCalledWith('build-box')

    await dispatcher().dispatch(request('managedServer.update', { selector: 'build-box' }))
    expect(registered.update).toHaveBeenCalledWith('build-box', false)
    await dispatcher().dispatch(
      request('managedServer.update', { selector: 'build-box', force: true })
    )
    expect(registered.update).toHaveBeenLastCalledWith('build-box', true)
  })

  it('rejects a missing selector before reaching an action', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    const response = await dispatcher().dispatch(request('managedServer.recover', {}))
    expect(response).toMatchObject({ ok: false })
    expect(registered.recover).not.toHaveBeenCalled()
  })

  it('passes the confirmed changed-state restore through to recover', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    await dispatcher().dispatch(
      request('managedServer.recover', { selector: 'build-box', acceptChangedState: true })
    )
    expect(registered.recover).toHaveBeenLastCalledWith('build-box', true)
    await dispatcher().dispatch(request('managedServer.recover', { selector: 'build-box' }))
    expect(registered.recover).toHaveBeenLastCalledWith('build-box', false)
  })
})
