import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { ANTIGRAVITY_ACCOUNT_METHODS } from './antigravity-accounts'

const { listAccounts, addCurrentAccount } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  addCurrentAccount: vi.fn()
}))

vi.mock('../../../antigravity/native-account-host', () => ({
  getAntigravityAccountService: vi.fn(() => ({ listAccounts, addCurrentAccount }))
}))

function runtimeWithDetection(
  automaticallyDetectAiAccounts?: boolean | (() => boolean)
): OrcaRuntimeService {
  const runtime = {
    getClientSettings: () => ({
      automaticallyDetectAiAccounts:
        typeof automaticallyDetectAiAccounts === 'function'
          ? automaticallyDetectAiAccounts()
          : automaticallyDetectAiAccounts
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only read getClientSettings from the execution-host runtime.
  return runtime as OrcaRuntimeService
}

function methodNamed(name: string) {
  const method = eraseRpcMethods(ANTIGRAVITY_ACCOUNT_METHODS).find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing request method: ${name}`)
  }
  return method
}

describe('Antigravity account discovery RPC', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([false, true, undefined])('uses the execution host setting %s', async (enabled) => {
    const method = methodNamed('accounts.antigravityList')
    await method.handler({ runtime: 'host' }, { runtime: runtimeWithDetection(enabled) })
    expect(listAccounts).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(listAccounts.mock.calls[0][0]()).toBe(enabled !== false)
  })

  it('passes a live host policy resolver instead of a settings snapshot', async () => {
    let enabled = true
    const runtime = runtimeWithDetection(() => enabled)
    await methodNamed('accounts.antigravityList').handler({ runtime: 'host' }, { runtime })
    const resolve = listAccounts.mock.calls[0][0]
    expect(resolve()).toBe(true)
    enabled = false
    expect(resolve()).toBe(false)
  })

  it('keeps explicit account import available when detection is disabled', async () => {
    const method = methodNamed('accounts.antigravityAddCurrent')
    await method.handler({ runtime: 'host' }, { runtime: runtimeWithDetection(false) })
    expect(addCurrentAccount).toHaveBeenCalledOnce()
  })
})
