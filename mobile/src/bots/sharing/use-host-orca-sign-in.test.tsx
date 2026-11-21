import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn() }))
vi.mock('../../transport/rpc/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  bindDeferredRpcOperation: (operation: { method: string }) => ({
    request: (_client: unknown, params: unknown) => mocks.request(operation.method, params),
    interpret: (reply: unknown) => reply
  })
}))
vi.mock('../../transport/rpc/rpc-operation-result-reader', () => ({ rpcResultVariant: () => null }))
vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink: mocks.open }))

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useHostOrcaSignIn, type HostOrcaSignIn } from './use-host-orca-sign-in'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked operations never touch the client.
const client = {} as RpcClient

let hook: ReturnType<typeof useHostOrcaSignIn> | null = null
function Probe() {
  hook = useHostOrcaSignIn(client, () => {})
  return null
}

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  hook = null
  mocks.request.mockReset()
  mocks.open.mockReset()
})

/** Starts a sign-in whose computer offers `verificationUrl`, then never answers a wait. */
async function signInWith(verificationUrl: string): Promise<HostOrcaSignIn | undefined> {
  mocks.request.mockImplementation((method: string) =>
    method === 'orcaAccount.signIn.start'
      ? Promise.resolve({
          flowId: 'flow-1',
          revision: 1,
          phase: 'waiting',
          prompt: { kind: 'approve-in-browser', verificationUrl }
        })
      : method === 'orcaAccount.signIn.wait'
        ? new Promise(() => {})
        : Promise.resolve({})
  )
  await act(async () => {
    tree = create(createElement(Probe))
  })
  await act(async () => hook?.start())
  return hook?.view
}

describe('signing the computer in to Orca from the phone', () => {
  it("opens Orca Cloud's own sign-in page", async () => {
    const view = await signInWith('https://login.onorca.dev/device?code=ABCD')
    expect(mocks.open).toHaveBeenCalledWith('https://login.onorca.dev/device?code=ABCD')
    expect(view).toEqual({ phase: 'waiting' })
  })

  it.each([
    'https://evil.example/device',
    'http://login.onorca.dev/device',
    'https://login.onorca.dev.evil.example/device',
    'https://login.onorca.dev:8443/device',
    'tel:+15550100',
    'orca://pair?code=x'
  ])('never opens %s, and ends the sign-in', async (url) => {
    const view = await signInWith(url)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.request).toHaveBeenCalledWith('orcaAccount.signIn.cancel', { flowId: 'flow-1' })
    expect(view?.phase).toBe('failed')
  })
})
