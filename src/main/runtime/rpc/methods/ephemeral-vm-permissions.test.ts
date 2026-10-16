import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { EPHEMERAL_VM_METHODS } from './ephemeral-vm'
import { registerEphemeralVmHost } from '../../ephemeral-vm-host-registry'
import type { RpcCallerScope } from '../rpc-caller-scope'

afterEach(() => registerEphemeralVmHost(null))

const untrustedScopes: RpcCallerScope[] = [
  { kind: 'mobile' },
  { kind: 'ssh-bridge', targetId: 'worker', remoteCliControl: false },
  { kind: 'ssh-bridge', targetId: 'worker', remoteCliControl: true }
]

it.each(untrustedScopes)(
  'denies every recipe method to $kind before invoking the host',
  async (scope) => {
    const hostCall = vi.fn(() => {
      throw new Error('untrusted provider invocation')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host property throws; the dispatcher must refuse these callers before any host invocation.
    registerEphemeralVmHost(new Proxy({}, { get: () => hostCall }) as never)
    const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
    for (const method of EPHEMERAL_VM_METHODS) {
      const response = await dispatcher.dispatch(
        { id: method.name, authToken: 'unused', method: method.name, params: {} },
        { callerScope: scope }
      )
      expect(response.ok, method.name).toBe(false)
      if (!response.ok) {
        expect(response.error.code, method.name).toBe('forbidden')
      }
    }
    expect(hostCall).not.toHaveBeenCalled()
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'stream',
        authToken: 'unused',
        method: 'ephemeralVm.provisionEvents',
        params: { provisionId: 'any' }
      },
      (raw) => replies.push(raw),
      { callerScope: scope }
    )
    expect(JSON.parse(replies[0])).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(hostCall).not.toHaveBeenCalled()
  }
)

const allowedScopes: RpcCallerScope[] = [{ kind: 'owner' }, { kind: 'runtime-paired', grants: [] }]

it.each(allowedScopes)('lets $kind invoke recipe discovery', async (callerScope) => {
  const listRecipes = vi
    .fn()
    .mockResolvedValue({ status: 'ok', repoPath: '/repo', recipes: [], diagnostics: [] })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recipe discovery invokes only listRecipes; every other method is outside this successful-call fixture.
  registerEphemeralVmHost({ listRecipes } as never)
  const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
  const response = await dispatcher.dispatch(
    {
      id: 'owner',
      authToken: 'unused',
      method: 'ephemeralVm.listRecipes',
      params: { repoId: 'repo' }
    },
    { callerScope }
  )
  expect(response.ok).toBe(true)
  expect(listRecipes).toHaveBeenCalledWith({ repoId: 'repo' })
})
