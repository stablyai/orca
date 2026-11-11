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
    isGrantedDevice: (origin) => grantedDevices.includes(origin)
  })
  const byName = (name: string) => {
    const method = list.find((entry) => entry.name === name)!
    return { handler: method.handler as (params: unknown, ctx: RpcContext) => unknown }
  }
  return { broker, byName }
}

function desktop(deviceId: string, originId = deviceId): RpcContext {
  return {
    runtime: { registerSubscriptionCleanup: () => {} } as unknown as RpcContext['runtime'],
    clientKind: 'runtime',
    caller: { kind: 'paired-device', deviceId },
    pairedDeviceId: deviceId,
    pairedDeviceOriginId: originId,
    connectionId: `conn-${deviceId}`
  }
}

describe('local command RPC methods', () => {
  it('refuses a device paired through a grant, even after it forked a key', async () => {
    const { broker, byName } = methods(['grant-device'])
    broker.attach('owner', 'owner-device', () => {})
    const { requestId } = broker.request({ command: 'ls', cwd: null, reason: null, agent: null })
    const settle = byName('localCommands.settle')
    await expect(
      Promise.resolve(
        settle.handler({ requestId, outcome: 'started' }, desktop('fork-1', 'grant-device'))
      )
    ).rejects.toThrow('local_command_forbidden')
    expect(broker.status(requestId).status).toBe('pending')
  })

  it('refuses a phone and the agent CLI as a desktop', async () => {
    const { broker, byName } = methods([])
    broker.attach('owner', 'owner-device', () => {})
    const { requestId } = broker.request({ command: 'ls', cwd: null, reason: null, agent: null })
    const settle = byName('localCommands.settle')
    const phone = { ...desktop('phone'), clientKind: 'mobile' as const }
    const cli = { ...desktop('cli'), caller: { kind: 'local-cli' as const } }
    for (const ctx of [phone, cli]) {
      await expect(
        Promise.resolve(settle.handler({ requestId, outcome: 'started' }, ctx))
      ).rejects.toThrow('local_command_forbidden')
    }
  })
})
