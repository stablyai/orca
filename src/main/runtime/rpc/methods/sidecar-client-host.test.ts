import { afterEach, describe, expect, it } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  RUNTIME_CAPABILITIES,
  SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { PluginSidecarStoredFrame } from '../../../../shared/plugins/plugin-sidecar-contract'
import type { PluginService } from '../../../plugins/plugin-service'
import { PluginSidecarMailbox } from '../../../plugins/plugin-sidecar-mailbox'
import {
  applySidecarFrameOnUiMachine,
  PluginSidecarUiExecutor
} from '../../../plugins/plugin-sidecar-ui-executor'
import type { RpcContext, RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'
import { setPluginServiceForRpc } from './plugins'
import { SIDECAR_CLIENT_HOST_METHODS } from './sidecar-client-host'

function method(name: string): RpcMethod {
  const found = SIDECAR_CLIENT_HOST_METHODS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`missing ${name}`)
  }
  if ('stream' in found) {
    throw new Error(`${name} is streaming`)
  }
  return found
}

function context(clientCapabilities?: readonly string[]): RpcContext {
  return {
    runtime: {} as RpcContext['runtime'],
    connectionId: 'connection-one',
    clientId: 'paired-device',
    clientCapabilities
  }
}

afterEach(() => setPluginServiceForRpc(null))

describe('sidecar.clientHost.latest', () => {
  it('is registered on the runtime RPC surface', () => {
    expect(ALL_RPC_METHODS.some((entry) => entry.name === 'sidecar.clientHost.latest')).toBe(true)
  })

  it('advertises sidecar.clientHost.v1 on the host and Electron clients only', () => {
    expect(RUNTIME_CAPABILITIES).toContain(SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY)
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY
    )
    expect(NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES).not.toContain(
      SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY
    )
  })

  it('returns an empty mailbox and the frames a plugin published', async () => {
    const sidecarMailbox = new PluginSidecarMailbox()
    setPluginServiceForRpc({ sidecarMailbox } as unknown as PluginService)

    const latest = method('sidecar.clientHost.latest')
    const capable = context([SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY])
    expect(latest.handler({}, capable)).toEqual({ frames: [] })

    sidecarMailbox.publish('chron0.discord-presence', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'Working in Orca' }
    })

    const result = await latest.handler({}, capable)
    expect(result).toEqual({
      frames: [
        expect.objectContaining({
          pluginKey: 'chron0.discord-presence',
          channel: 'presence',
          payload: { details: 'Working in Orca' }
        })
      ]
    })

    const filtered = await latest.handler({ pluginKey: 'orca-samples.demo' }, capable)
    expect(filtered).toEqual({ frames: [] })
  })

  it('refuses callers that advertised capabilities without sidecar.clientHost.v1', async () => {
    setPluginServiceForRpc({
      sidecarMailbox: new PluginSidecarMailbox()
    } as unknown as PluginService)

    expect(() => method('sidecar.clientHost.latest').handler({}, context([]))).toThrow(
      'sidecar.clientHost.v1 is required'
    )
  })

  it('allows in-process callers that did not send a capability list', async () => {
    const sidecarMailbox = new PluginSidecarMailbox()
    sidecarMailbox.publish('chron0.discord-presence', { channel: 'presence', op: 'clear' })
    setPluginServiceForRpc({ sidecarMailbox } as unknown as PluginService)

    expect(method('sidecar.clientHost.latest').handler({}, context())).toEqual({
      frames: [expect.objectContaining({ pluginKey: 'chron0.discord-presence', op: 'clear' })]
    })
  })

  it('feeds the UI-machine executor stub without claiming Discord IPC', async () => {
    const sidecarMailbox = new PluginSidecarMailbox()
    sidecarMailbox.publish('chron0.discord-presence', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'Working in Orca' }
    })
    setPluginServiceForRpc({ sidecarMailbox } as unknown as PluginService)
    const pulled = (await method('sidecar.clientHost.latest').handler(
      {},
      context([SIDECAR_CLIENT_HOST_RUNTIME_CAPABILITY])
    )) as { frames: PluginSidecarStoredFrame[] }

    const applied = applySidecarFrameOnUiMachine(new PluginSidecarUiExecutor(), pulled.frames[0]!)
    expect(applied.discordIpc).toBe('not-implemented')
    expect(applied.applied).toBe(true)
  })
})
