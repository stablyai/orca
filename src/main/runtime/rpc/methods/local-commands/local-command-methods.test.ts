import { describe, expect, it } from 'vitest'
import { LocalCommandBroker } from '../../../local-commands/local-command-broker'
import type { RpcContext } from '../../core'
import { createLocalCommandMethods } from './local-command-methods'

function methods(grantedDevices: string[]) {
  const broker = new LocalCommandBroker()
  const list = createLocalCommandMethods({
    broker: () => broker,
    enabled: () => true,
    callerTerminal: () => null,
    isGrantedDevice: async (origin) => grantedDevices.includes(origin)
  })
  const [, , settle] = list
  return { broker, settle }
}

function desktop(deviceId: string, originId = deviceId): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settle never touches the runtime.
    runtime: {} as RpcContext['runtime'],
    clientKind: 'runtime',
    caller: { kind: 'paired-device', deviceId },
    pairedDeviceId: deviceId,
    pairedDeviceOriginId: originId,
    connectionId: `conn-${deviceId}`
  }
}

describe('local command RPC methods', () => {
  it('refuses a device paired through a grant, even after it forked a key', async () => {
    const { broker, settle } = methods(['grant-device'])
    broker.attach('owner', 'owner-device', () => {})
    const { requestId } = broker.request({ command: 'ls', cwd: null, reason: null, agent: null })
    await expect(
      Promise.resolve(
        settle.handler({ requestId, outcome: 'started' }, desktop('fork-1', 'grant-device'))
      )
    ).rejects.toThrow('local_command_forbidden')
    expect(broker.status(requestId).status).toBe('pending')
  })

  it('refuses a phone and the agent CLI as a desktop', async () => {
    const { broker, settle } = methods([])
    broker.attach('owner', 'owner-device', () => {})
    const { requestId } = broker.request({ command: 'ls', cwd: null, reason: null, agent: null })
    const phone = { ...desktop('phone'), clientKind: 'mobile' as const }
    const cli = { ...desktop('cli'), caller: { kind: 'local-cli' as const } }
    for (const ctx of [phone, cli]) {
      await expect(
        Promise.resolve(settle.handler({ requestId, outcome: 'started' }, ctx))
      ).rejects.toThrow('local_command_forbidden')
    }
  })
})
