import { describe, expect, it } from 'vitest'
import { LOCAL_CLI_RPC_CALLER } from './rpc-caller-identity'
import { resolveRpcWorkspaceCreatorProvenance } from './workspace-creator-context'

describe('resolveRpcWorkspaceCreatorProvenance', () => {
  it('names a paired device by its device id', () => {
    expect(
      resolveRpcWorkspaceCreatorProvenance({
        caller: { kind: 'paired-device', deviceId: 'device-1' },
        pairedDeviceId: 'device-1',
        clientId: 'token',
        clientKind: 'mobile',
        connectionId: 'ws-1'
      })
    ).toEqual({ kind: 'paired-device', deviceId: 'device-1' })
  })

  it('creates as the host for the CLI and for an owner local stream', () => {
    expect(resolveRpcWorkspaceCreatorProvenance({})).toEqual({ kind: 'host' })
    expect(
      resolveRpcWorkspaceCreatorProvenance({
        caller: LOCAL_CLI_RPC_CALLER,
        clientId: 'local-stream-1',
        clientKind: 'runtime',
        connectionId: 'local-stream-1'
      })
    ).toEqual({ kind: 'host' })
  })

  it('refuses a declared client with no identity', () => {
    expect(() =>
      resolveRpcWorkspaceCreatorProvenance({
        clientId: 'client-1',
        clientKind: 'runtime',
        connectionId: 'conn-1'
      })
    ).toThrow('authenticated_device_identity_missing')
  })
})
