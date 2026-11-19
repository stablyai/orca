import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { denyRpcMethodForCaller } from '../callers/rpc-caller-scope'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../server/runtime-rpc-mobile-method-allowlist'
import {
  installOrcaServerSignIn,
  OrcaServerSignIn
} from '../../../orca-profiles/orca-server-sign-in'
import { ORCA_ACCOUNT_METHODS } from './orca-account'

function requestMethod(name: string) {
  const found = eraseRpcMethods(ORCA_ACCOUNT_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  return found
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read no runtime member.
const runtime = {} as unknown as OrcaRuntimeService

afterEach(() => installOrcaServerSignIn(null))

describe('Orca account RPC methods', () => {
  it('needs exactly the power to run commands on the host, for every caller kind', () => {
    for (const method of ORCA_ACCOUNT_METHODS) {
      expect(method.permission).toBe('workspace')
      expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method.name)).toBe(true)
      expect(
        denyRpcMethodForCaller({ kind: 'mobile', delegated: true }, method.name, 'workspace')
      ).toBeNull()
      expect(
        denyRpcMethodForCaller({ kind: 'runtime-paired', grants: [] }, method.name, 'workspace')
      ).toBeNull()
    }
  })

  it('tells an older-host caller to update when the host has no account sign-in', async () => {
    await expect(
      requestMethod('orcaAccount.status').handler(undefined, { runtime })
    ).rejects.toThrow('Signing in to Orca is not available on this host. Update Orca on it.')
  })

  it('refuses a flow to a transport that cannot name its caller', async () => {
    installOrcaServerSignIn(
      new OrcaServerSignIn({
        account: {
          getAuthStatus: vi.fn(),
          signInWithCode: vi.fn(),
          selectOrg: vi.fn(),
          signOut: vi.fn(),
          refreshAuth: vi.fn()
        }
      })
    )
    await expect(
      requestMethod('orcaAccount.signIn.start').handler({}, { runtime, clientKind: 'runtime' })
    ).rejects.toThrow('This client cannot sign this host in.')
  })

  it('starts the flow for the calling device', async () => {
    const server = new OrcaServerSignIn({
      account: {
        getAuthStatus: vi.fn(),
        signInWithCode: vi.fn(),
        selectOrg: vi.fn(),
        signOut: vi.fn(),
        refreshAuth: vi.fn()
      }
    })
    const start = vi.spyOn(server, 'startSignIn').mockReturnValue({
      flowId: 'flow-1',
      provider: 'switch-account',
      revision: 1,
      phase: 'starting'
    })
    installOrcaServerSignIn(server)

    await requestMethod('orcaAccount.signIn.start').handler(
      { switchAccount: true },
      { runtime, caller: { kind: 'paired-device', deviceId: 'phone-1' } }
    )

    expect(start).toHaveBeenCalledWith('phone-1', 'switch-account', {
      approveInBrowser: undefined
    })
    await requestMethod('orcaAccount.signIn.start').handler(
      { approveInBrowser: true },
      { runtime, caller: { kind: 'paired-device', deviceId: 'phone-1' } }
    )
    expect(start).toHaveBeenLastCalledWith('phone-1', 'sign-in', { approveInBrowser: true })
  })
})
